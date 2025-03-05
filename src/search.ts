import { chromium, devices, BrowserContextOptions, Browser } from "playwright";
import { SearchResponse, SearchResult, CommandOptions } from "./types.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import logger from "./logger.js";
import { url } from "inspector";

// 指纹配置接口
interface FingerprintConfig {
  deviceName: string;
  locale: string;
  timezoneId: string;
  colorScheme: "dark" | "light";
  reducedMotion: "reduce" | "no-preference";
  forcedColors: "active" | "none";
}

// 保存的状态文件接口
interface SavedState {
  fingerprint?: FingerprintConfig;
  googleDomain?: string;
}

/**
 * 获取宿主机器的实际配置
 * @param userLocale 用户指定的区域设置（如果有）
 * @returns 基于宿主机器的指纹配置
 */
function getHostMachineConfig(userLocale?: string): FingerprintConfig {
  // 获取系统区域设置
  const systemLocale = userLocale || process.env.LANG || "zh-CN";

  // 获取系统时区
  // Node.js 不直接提供时区信息，但可以通过时区偏移量推断
  const timezoneOffset = new Date().getTimezoneOffset();
  let timezoneId = "Asia/Shanghai"; // 默认使用上海时区

  // 根据时区偏移量粗略推断时区
  // 时区偏移量是以分钟为单位，与UTC的差值，负值表示东区
  if (timezoneOffset <= -480 && timezoneOffset > -600) {
    // UTC+8 (中国、新加坡、香港等)
    timezoneId = "Asia/Shanghai";
  } else if (timezoneOffset <= -540) {
    // UTC+9 (日本、韩国等)
    timezoneId = "Asia/Tokyo";
  } else if (timezoneOffset <= -420 && timezoneOffset > -480) {
    // UTC+7 (泰国、越南等)
    timezoneId = "Asia/Bangkok";
  } else if (timezoneOffset <= 0 && timezoneOffset > -60) {
    // UTC+0 (英国等)
    timezoneId = "Europe/London";
  } else if (timezoneOffset <= 60 && timezoneOffset > 0) {
    // UTC-1 (欧洲部分地区)
    timezoneId = "Europe/Berlin";
  } else if (timezoneOffset <= 300 && timezoneOffset > 240) {
    // UTC-5 (美国东部)
    timezoneId = "America/New_York";
  }

  // 检测系统颜色方案
  // Node.js 无法直接获取系统颜色方案，使用合理的默认值
  // 可以根据时间推断：晚上使用深色模式，白天使用浅色模式
  const hour = new Date().getHours();
  const colorScheme =
    hour >= 19 || hour < 7 ? ("dark" as const) : ("light" as const);

  // 其他设置使用合理的默认值
  const reducedMotion = "no-preference" as const; // 大多数用户不会启用减少动画
  const forcedColors = "none" as const; // 大多数用户不会启用强制颜色

  // 选择一个合适的设备名称
  // 根据操作系统选择合适的浏览器
  const platform = os.platform();
  let deviceName = "Desktop Chrome"; // 默认使用Chrome

  if (platform === "darwin") {
    // macOS
    deviceName = "Desktop Safari";
  } else if (platform === "win32") {
    // Windows
    deviceName = "Desktop Edge";
  } else if (platform === "linux") {
    // Linux
    deviceName = "Desktop Firefox";
  }

  // 我们使用的Chrome
  deviceName = "Desktop Chrome";

  return {
    deviceName,
    locale: systemLocale,
    timezoneId,
    colorScheme,
    reducedMotion,
    forcedColors,
  };
}

/**
 * 执行Google搜索并返回结果
 * @param query 搜索关键词
 * @param options 搜索选项
 * @returns 搜索结果
 */
export async function googleSearch(
  query: string,
  options: CommandOptions = {},
  existingBrowser?: Browser
): Promise<SearchResponse> {
  // 设置默认选项
  const {
    limit = 10,
    timeout = 60000,
    stateFile = "./browser-state.json",
    noSaveState = false,
    locale = "zh-CN", // 默认使用中文
  } = options;

  // 忽略传入的headless参数，总是以无头模式启动
  let useHeadless = true;

  logger.info({ options }, "Executing Google search");

  // 检查是否存在状态文件
  let storageState: string | undefined = undefined;
  let savedState: SavedState = {};

  // 指纹配置文件路径
  const fingerprintFile = stateFile.replace(".json", "-fingerprint.json");

  if (fs.existsSync(stateFile)) {
    logger.info(
      { stateFile },
      "Found browser state file, will use saved browser state to avoid robot detection"
    );
    storageState = stateFile;

    // 尝试加载保存的指纹配置
    if (fs.existsSync(fingerprintFile)) {
      try {
        const fingerprintData = fs.readFileSync(fingerprintFile, "utf8");
        savedState = JSON.parse(fingerprintData);
        logger.info("Loaded saved browser fingerprint configuration");
      } catch (e) {
        logger.warn({ error: e }, "Unable to load fingerprint configuration file, will create new fingerprint");
      }
    }
  } else {
    logger.info(
      { stateFile },
      "No browser state file found, will create new browser session and fingerprint"
    );
  }

  // 只使用桌面设备列表
  const deviceList = [
    "Desktop Chrome",
    "Desktop Edge",
    "Desktop Firefox",
    "Desktop Safari",
  ];

  // 时区列表
  const timezoneList = [
    "America/New_York",
    "Europe/London",
    "Asia/Shanghai",
    "Europe/Berlin",
    "Asia/Tokyo",
  ];

  // Google域名列表
  const googleDomains = [
    "https://www.google.com",
    "https://www.google.co.uk",
    "https://www.google.ca",
    "https://www.google.com.au",
  ];

  // 获取随机设备配置或使用保存的配置
  const getDeviceConfig = (): [string, any] => {
    if (
      savedState.fingerprint?.deviceName &&
      devices[savedState.fingerprint.deviceName]
    ) {
      // 使用保存的设备配置
      return [
        savedState.fingerprint.deviceName,
        devices[savedState.fingerprint.deviceName],
      ];
    } else {
      // 随机选择一个设备
      const randomDevice =
        deviceList[Math.floor(Math.random() * deviceList.length)];
      return [randomDevice, devices[randomDevice]];
    }
  };

  // 获取随机延迟时间
  const getRandomDelay = (min: number, max: number) => {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  };

  // 定义一个函数来执行搜索，可以重用于无头和有头模式
  async function performSearch(headless: boolean): Promise<SearchResponse> {
    let browser: Browser;
    let browserWasProvided = false;

    if (existingBrowser) {
      browser = existingBrowser;
      browserWasProvided = true;
      logger.info("Using existing browser instance");
    } else {
      logger.info(
        { headless },
        `Preparing to start browser in ${headless ? "headless" : "headed"} mode...`
      );

      // 初始化浏览器，添加更多参数以避免检测
      browser = await chromium.launch({
        headless,
        timeout: timeout * 2, // 增加浏览器启动超时时间
        args: [
          "--disable-blink-features=AutomationControlled",
          "--disable-features=IsolateOrigins,site-per-process",
          "--disable-site-isolation-trials",
          "--disable-web-security",
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-accelerated-2d-canvas",
          "--no-first-run",
          "--no-zygote",
          "--disable-gpu",
          "--hide-scrollbars",
          "--mute-audio",
          "--disable-background-networking",
          "--disable-background-timer-throttling",
          "--disable-backgrounding-occluded-windows",
          "--disable-breakpad",
          "--disable-component-extensions-with-background-pages",
          "--disable-extensions",
          "--disable-features=TranslateUI",
          "--disable-ipc-flooding-protection",
          "--disable-renderer-backgrounding",
          "--enable-features=NetworkService,NetworkServiceInProcess",
          "--force-color-profile=srgb",
          "--metrics-recording-only",
        ],
        ignoreDefaultArgs: ["--enable-automation"],
      });

      logger.info("Browser started successfully!");
    }

    // 获取设备配置 - 使用保存的或随机生成
    const [deviceName, deviceConfig] = getDeviceConfig();

    // 创建浏览器上下文选项
    let contextOptions: BrowserContextOptions = {
      ...deviceConfig,
    };

    // 如果有保存的指纹配置，使用它；否则使用宿主机器的实际设置
    if (savedState.fingerprint) {
      contextOptions = {
        ...contextOptions,
        locale: savedState.fingerprint.locale,
        timezoneId: savedState.fingerprint.timezoneId,
        colorScheme: savedState.fingerprint.colorScheme,
        reducedMotion: savedState.fingerprint.reducedMotion,
        forcedColors: savedState.fingerprint.forcedColors,
      };
      logger.info("Using saved browser fingerprint configuration");
    } else {
      // 获取宿主机器的实际设置
      const hostConfig = getHostMachineConfig(locale);

      // 如果需要使用不同的设备类型，重新获取设备配置
      if (hostConfig.deviceName !== deviceName) {
        logger.info(
          { deviceType: hostConfig.deviceName },
          "Using device type based on host machine settings"
        );
        // 使用新的设备配置
        contextOptions = { ...devices[hostConfig.deviceName] };
      }

      contextOptions = {
        ...contextOptions,
        locale: hostConfig.locale,
        timezoneId: hostConfig.timezoneId,
        colorScheme: hostConfig.colorScheme,
        reducedMotion: hostConfig.reducedMotion,
        forcedColors: hostConfig.forcedColors,
      };

      // 保存新生成的指纹配置
      savedState.fingerprint = hostConfig;
      logger.info(
        {
          locale: hostConfig.locale,
          timezone: hostConfig.timezoneId,
          colorScheme: hostConfig.colorScheme,
          deviceType: hostConfig.deviceName,
        },
        "Generated new browser fingerprint configuration based on host machine"
      );
    }

    // 添加通用选项 - 确保使用桌面配置
    contextOptions = {
      ...contextOptions,
      permissions: ["geolocation", "notifications"],
      acceptDownloads: true,
      isMobile: false, // 强制使用桌面模式
      hasTouch: false, // 禁用触摸功能
      javaScriptEnabled: true,
    };

    if (storageState) {
      logger.info("Loading saved browser state...");
    }

    const context = await browser.newContext(
      storageState ? { ...contextOptions, storageState } : contextOptions
    );

    // 设置额外的浏览器属性以避免检测
    await context.addInitScript(() => {
      // 覆盖 navigator 属性
      Object.defineProperty(navigator, "webdriver", { get: () => false });
      Object.defineProperty(navigator, "plugins", {
        get: () => [1, 2, 3, 4, 5],
      });
      Object.defineProperty(navigator, "languages", {
        get: () => ["en-US", "en", "zh-CN"],
      });

      // 覆盖 window 属性
      // @ts-ignore - 忽略 chrome 属性不存在的错误
      window.chrome = {
        runtime: {},
        loadTimes: function () {},
        csi: function () {},
        app: {},
      };

      // 添加 WebGL 指纹随机化
      if (typeof WebGLRenderingContext !== "undefined") {
        const getParameter = WebGLRenderingContext.prototype.getParameter;
        WebGLRenderingContext.prototype.getParameter = function (
          parameter: number
        ) {
          // 随机化 UNMASKED_VENDOR_WEBGL 和 UNMASKED_RENDERER_WEBGL
          if (parameter === 37445) {
            return "Intel Inc.";
          }
          if (parameter === 37446) {
            return "Intel Iris OpenGL Engine";
          }
          return getParameter.call(this, parameter);
        };
      }
    });

    const page = await context.newPage();

    // 设置页面额外属性
    await page.addInitScript(() => {
      // 模拟真实的屏幕尺寸和颜色深度
      Object.defineProperty(window.screen, "width", { get: () => 1920 });
      Object.defineProperty(window.screen, "height", { get: () => 1080 });
      Object.defineProperty(window.screen, "colorDepth", { get: () => 24 });
      Object.defineProperty(window.screen, "pixelDepth", { get: () => 24 });
    });

    try {
      // 使用保存的Google域名或随机选择一个
      let selectedDomain: string;
      if (savedState.googleDomain) {
        selectedDomain = savedState.googleDomain;
        logger.info({ domain: selectedDomain }, "Using saved Google domain");
      } else {
        selectedDomain =
          googleDomains[Math.floor(Math.random() * googleDomains.length)];
        // 保存选择的域名
        savedState.googleDomain = selectedDomain;
        logger.info({ domain: selectedDomain }, "Randomly selected Google domain");
      }

      logger.info("Accessing Google search page...");

      // 访问Google搜索页面
      const response = await page.goto(selectedDomain, {
        timeout,
        waitUntil: "networkidle",
      });

      // 检查是否被重定向到人机验证页面
      const currentUrl = page.url();
      const sorryPatterns = [
        "google.com/sorry/index",
        "google.com/sorry",
        "recaptcha",
        "captcha",
        "unusual traffic",
      ];

      const isBlockedPage = sorryPatterns.some(
        (pattern) =>
          currentUrl.includes(pattern) ||
          (response && response.url().toString().includes(pattern))
      );

      if (isBlockedPage) {
        if (headless) {
          logger.warn("Detected blocked page, will restart browser in headed mode...");

          // 关闭当前页面和上下文
          await page.close();
          await context.close();

          // 如果是外部提供的浏览器，不关闭它，而是创建一个新的浏览器实例
          if (browserWasProvided) {
            logger.info(
              "Using external browser instance when encountering blocked page, creating new browser instance..."
            );
            // 创建一个新的浏览器实例，不再使用外部提供的实例
            const newBrowser = await chromium.launch({
              headless: false, // 使用有头模式
              timeout: timeout * 2,
              args: [
                "--disable-blink-features=AutomationControlled",
                // 其他参数与原来相同
                "--disable-features=IsolateOrigins,site-per-process",
                "--disable-site-isolation-trials",
                "--disable-web-security",
                "--no-sandbox",
                "--disable-setuid-sandbox",
                "--disable-dev-shm-usage",
                "--disable-accelerated-2d-canvas",
                "--no-first-run",
                "--no-zygote",
                "--disable-gpu",
                "--hide-scrollbars",
                "--mute-audio",
                "--disable-background-networking",
                "--disable-background-timer-throttling",
                "--disable-backgrounding-occluded-windows",
                "--disable-breakpad",
                "--disable-component-extensions-with-background-pages",
                "--disable-extensions",
                "--disable-features=TranslateUI",
                "--disable-ipc-flooding-protection",
                "--disable-renderer-backgrounding",
                "--enable-features=NetworkService,NetworkServiceInProcess",
                "--force-color-profile=srgb",
                "--metrics-recording-only",
              ],
              ignoreDefaultArgs: ["--enable-automation"],
            });

            // 使用新的浏览器实例执行搜索
            try {
              const tempContext = await newBrowser.newContext(contextOptions);
              const tempPage = await tempContext.newPage();

              // 这里可以添加处理人机验证的代码
              // ...

              // 完成后关闭临时浏览器
              await newBrowser.close();

              // 重新执行搜索
              return performSearch(false);
            } catch (error) {
              await newBrowser.close();
              throw error;
            }
          } else {
            // 如果不是外部提供的浏览器，直接关闭并重新执行搜索
            await browser.close();
            return performSearch(false); // 以有头模式重新执行搜索
          }
        } else {
          logger.warn("Detected blocked page, please complete verification in the browser...");
          // 等待用户完成验证并重定向回搜索页面
          await page.waitForNavigation({
            timeout: timeout * 2,
            url: (url) => {
              const urlStr = url.toString();
              return sorryPatterns.every(
                (pattern) => !urlStr.includes(pattern)
              );
            },
          });
          logger.info("Human verification completed, continuing search...");
        }
      }

      logger.info({ query }, "Inputting search keywords");

      // 等待搜索框出现 - 尝试多个可能的选择器
      const searchInputSelectors = [
        "textarea[name='q']",
        "input[name='q']",
        "textarea[title='Search']",
        "input[title='Search']",
        "textarea[aria-label='Search']",
        "input[aria-label='Search']",
        "textarea",
      ];

      let searchInput = null;
      for (const selector of searchInputSelectors) {
        searchInput = await page.$(selector);
        if (searchInput) {
          logger.info({ selector }, "Found search input");
          break;
        }
      }

      if (!searchInput) {
        logger.error("Unable to find search input");
        throw new Error("Unable to find search input");
      }

      // 直接点击搜索框，减少延迟
      await searchInput.click();

      // 直接输入整个查询字符串，而不是逐个字符输入
      await page.keyboard.type(query, { delay: getRandomDelay(10, 30) });

      // 减少按回车前的延迟
      await page.waitForTimeout(getRandomDelay(100, 300));
      await page.keyboard.press("Enter");

      logger.info("Waiting for page load to complete...");

      // 等待页面加载完成
      await page.waitForLoadState("networkidle", { timeout });

      // 检查搜索后的URL是否被重定向到人机验证页面
      const searchUrl = page.url();
      const isBlockedAfterSearch = sorryPatterns.some((pattern) =>
        searchUrl.includes(pattern)
      );

      if (isBlockedAfterSearch) {
        if (headless) {
          logger.warn(
            "Detected blocked page after search, will restart browser in headed mode..."
          );

          // 关闭当前页面和上下文
          await page.close();
          await context.close();

          // 如果是外部提供的浏览器，不关闭它，而是创建一个新的浏览器实例
          if (browserWasProvided) {
            logger.info(
              "Using external browser instance when encountering blocked page after search, creating new browser instance..."
            );
            // 创建一个新的浏览器实例，不再使用外部提供的实例
            const newBrowser = await chromium.launch({
              headless: false, // 使用有头模式
              timeout: timeout * 2,
              args: [
                "--disable-blink-features=AutomationControlled",
                // 其他参数与原来相同
                "--disable-features=IsolateOrigins,site-per-process",
                "--disable-site-isolation-trials",
                "--disable-web-security",
                "--no-sandbox",
                "--disable-setuid-sandbox",
                "--disable-dev-shm-usage",
                "--disable-accelerated-2d-canvas",
                "--no-first-run",
                "--no-zygote",
                "--disable-gpu",
                "--hide-scrollbars",
                "--mute-audio",
                "--disable-background-networking",
                "--disable-background-timer-throttling",
                "--disable-backgrounding-occluded-windows",
                "--disable-breakpad",
                "--disable-component-extensions-with-background-pages",
                "--disable-extensions",
                "--disable-features=TranslateUI",
                "--disable-ipc-flooding-protection",
                "--disable-renderer-backgrounding",
                "--enable-features=NetworkService,NetworkServiceInProcess",
                "--force-color-profile=srgb",
                "--metrics-recording-only",
              ],
              ignoreDefaultArgs: ["--enable-automation"],
            });

            // 使用新的浏览器实例执行搜索
            try {
              const tempContext = await newBrowser.newContext(contextOptions);
              const tempPage = await tempContext.newPage();

              // 这里可以添加处理人机验证的代码
              // ...

              // 完成后关闭临时浏览器
              await newBrowser.close();

              // 重新执行搜索
              return performSearch(false);
            } catch (error) {
              await newBrowser.close();
              throw error;
            }
          } else {
            // 如果不是外部提供的浏览器，直接关闭并重新执行搜索
            await browser.close();
            return performSearch(false); // 以有头模式重新执行搜索
          }
        } else {
          logger.warn("Detected blocked page after search, please complete verification in the browser...");
          // 等待用户完成验证并重定向回搜索页面
          await page.waitForNavigation({
            timeout: timeout * 2,
            url: (url) => {
              const urlStr = url.toString();
              return sorryPatterns.every(
                (pattern) => !urlStr.includes(pattern)
              );
            },
          });
          logger.info("Human verification completed, continuing search...");

          // 等待页面重新加载
          await page.waitForLoadState("networkidle", { timeout });
        }
      }

      logger.info({ url: page.url() }, "Waiting for search results to load...");

      // 尝试多个可能的搜索结果选择器
      const searchResultSelectors = [
        "#search",
        "#rso",
        ".g",
        "[data-sokoban-container]",
        "div[role='main']",
      ];

      let resultsFound = false;
      for (const selector of searchResultSelectors) {
        try {
          await page.waitForSelector(selector, { timeout: timeout / 2 });
          logger.info({ selector }, "Found search result");
          resultsFound = true;
          break;
        } catch (e) {
          // 继续尝试下一个选择器
        }
      }

      if (!resultsFound) {
        // 如果找不到搜索结果，检查是否被重定向到人机验证页面
        const currentUrl = page.url();
        const isBlockedDuringResults = sorryPatterns.some((pattern) =>
          currentUrl.includes(pattern)
        );

        if (isBlockedDuringResults) {
          if (headless) {
            logger.warn(
              "Detected blocked page during search results, will restart browser in headed mode..."
            );

            // 关闭当前页面和上下文
            await page.close();
            await context.close();

            // 如果是外部提供的浏览器，不关闭它，而是创建一个新的浏览器实例
            if (browserWasProvided) {
              logger.info(
                "Using external browser instance when encountering blocked page during search results, creating new browser instance..."
              );
              // 创建一个新的浏览器实例，不再使用外部提供的实例
              const newBrowser = await chromium.launch({
                headless: false, // 使用有头模式
                timeout: timeout * 2,
                args: [
                  "--disable-blink-features=AutomationControlled",
                  // 其他参数与原来相同
                  "--disable-features=IsolateOrigins,site-per-process",
                  "--disable-site-isolation-trials",
                  "--disable-web-security",
                  "--no-sandbox",
                  "--disable-setuid-sandbox",
                  "--disable-dev-shm-usage",
                  "--disable-accelerated-2d-canvas",
                  "--no-first-run",
                  "--no-zygote",
                  "--disable-gpu",
                  "--hide-scrollbars",
                  "--mute-audio",
                  "--disable-background-networking",
                  "--disable-background-timer-throttling",
                  "--disable-backgrounding-occluded-windows",
                  "--disable-breakpad",
                  "--disable-component-extensions-with-background-pages",
                  "--disable-extensions",
                  "--disable-features=TranslateUI",
                  "--disable-ipc-flooding-protection",
                  "--disable-renderer-backgrounding",
                  "--enable-features=NetworkService,NetworkServiceInProcess",
                  "--force-color-profile=srgb",
                  "--metrics-recording-only",
                ],
                ignoreDefaultArgs: ["--enable-automation"],
              });

              // 使用新的浏览器实例执行搜索
              try {
                const tempContext = await newBrowser.newContext(contextOptions);
                const tempPage = await tempContext.newPage();

                // 这里可以添加处理人机验证的代码
                // ...

                // 完成后关闭临时浏览器
                await newBrowser.close();

                // 重新执行搜索
                return performSearch(false);
              } catch (error) {
                await newBrowser.close();
                throw error;
              }
            } else {
              // 如果不是外部提供的浏览器，直接关闭并重新执行搜索
              await browser.close();
              return performSearch(false); // 以有头模式重新执行搜索
            }
          } else {
            logger.warn(
              "Detected blocked page during search results, please complete verification in the browser..."
            );
            // 等待用户完成验证并重定向回搜索页面
            await page.waitForNavigation({
              timeout: timeout * 2,
              url: (url) => {
                const urlStr = url.toString();
                return sorryPatterns.every(
                  (pattern) => !urlStr.includes(pattern)
                );
              },
            });
            logger.info("Human verification completed, continuing search...");

            // 再次尝试等待搜索结果
            for (const selector of searchResultSelectors) {
              try {
                await page.waitForSelector(selector, { timeout: timeout / 2 });
                logger.info({ selector }, "Verified and found search result");
                resultsFound = true;
                break;
              } catch (e) {
                // 继续尝试下一个选择器
              }
            }

            if (!resultsFound) {
              logger.error("Unable to find search result element");
              throw new Error("Unable to find search result element");
            }
          }
        } else {
          // 如果不是人机验证问题，则抛出错误
          logger.error("Unable to find search result element");
          throw new Error("Unable to find search result element");
        }
      }

      // 减少等待时间
      await page.waitForTimeout(getRandomDelay(200, 500));

      logger.info("Extracting search results...");

      // 提取搜索结果 - 尝试多种选择器组合
      const resultSelectors = [
        { container: "#search .g", title: "h3", snippet: ".VwiC3b" },
        { container: "#rso .g", title: "h3", snippet: ".VwiC3b" },
        { container: ".g", title: "h3", snippet: ".VwiC3b" },
        {
          container: "[data-sokoban-container] > div",
          title: "h3",
          snippet: "[data-sncf='1']",
        },
        {
          container: "div[role='main'] .g",
          title: "h3",
          snippet: "[data-sncf='1']",
        },
      ];

      let results: SearchResult[] = [];

      for (const selector of resultSelectors) {
        try {
          results = await page.$$eval(
            selector.container,
            (
              elements: Element[],
              params: {
                maxResults: number;
                titleSelector: string;
                snippetSelector: string;
              }
            ) => {
              return elements
                .slice(0, params.maxResults)
                .map((el: Element) => {
                  const titleElement = el.querySelector(params.titleSelector);
                  const linkElement = el.querySelector("a");
                  const snippetElement = el.querySelector(
                    params.snippetSelector
                  );

                  return {
                    title: titleElement ? titleElement.textContent || "" : "",
                    link:
                      linkElement && linkElement instanceof HTMLAnchorElement
                        ? linkElement.href
                        : "",
                    snippet: snippetElement
                      ? snippetElement.textContent || ""
                      : "",
                  };
                })
                .filter(
                  (item: { title: string; link: string; snippet: string }) =>
                    item.title && item.link
                ); // 过滤掉空结果
            },
            {
              maxResults: limit,
              titleSelector: selector.title,
              snippetSelector: selector.snippet,
            }
          );

          if (results.length > 0) {
            logger.info({ selector: selector.container }, "Successfully extracted results");
            break;
          }
        } catch (e) {
          // 继续尝试下一个选择器组合
        }
      }

      // 如果所有选择器都失败，尝试一个更通用的方法
      if (results.length === 0) {
        logger.info("Using fallback method to extract search results...");
        results = await page.$$eval(
          "a[href^='http']",
          (elements: Element[], maxResults: number) => {
            return elements
              .filter((el: Element) => {
                // 过滤掉导航链接、图片链接等
                const href = el.getAttribute("href") || "";
                return (
                  href.startsWith("http") &&
                  !href.includes("google.com/") &&
                  !href.includes("accounts.google") &&
                  !href.includes("support.google")
                );
              })
              .slice(0, maxResults)
              .map((el: Element) => {
                const title = el.textContent || "";
                const link =
                  el instanceof HTMLAnchorElement
                    ? el.href
                    : el.getAttribute("href") || "";
                // 尝试获取周围的文本作为摘要
                let snippet = "";
                let parent = el.parentElement;
                for (let i = 0; i < 3 && parent; i++) {
                  const text = parent.textContent || "";
                  if (text.length > snippet.length && text !== title) {
                    snippet = text;
                  }
                  parent = parent.parentElement;
                }

                return { title, link, snippet };
              })
              .filter(
                (item: { title: string; link: string; snippet: string }) =>
                  item.title && item.link
              ); // 过滤掉空结果
          },
          limit
        );
      }

      logger.info({ count: results.length }, "Successfully retrieved search results");

      try {
        // 保存浏览器状态（除非用户指定了不保存）
        if (!noSaveState) {
          logger.info({ stateFile }, "Saving browser state...");

          // 确保目录存在
          const stateDir = path.dirname(stateFile);
          if (!fs.existsSync(stateDir)) {
            fs.mkdirSync(stateDir, { recursive: true });
          }

          // 保存状态
          await context.storageState({ path: stateFile });
          logger.info("Browser state saved successfully!");

          // 保存指纹配置
          try {
            fs.writeFileSync(
              fingerprintFile,
              JSON.stringify(savedState, null, 2),
              "utf8"
            );
            logger.info({ fingerprintFile }, "Fingerprint configuration saved");
          } catch (fingerprintError) {
            logger.error({ error: fingerprintError }, "Error saving fingerprint configuration");
          }
        } else {
          logger.info("According to user settings, browser state will not be saved");
        }
      } catch (error) {
        logger.error({ error }, "Error saving browser state");
      }

      // 只有在浏览器不是外部提供的情况下才关闭浏览器
      if (!browserWasProvided) {
        logger.info("Closing browser...");
        await browser.close();
      } else {
        logger.info("Keeping browser instance open");
      }

      // 返回搜索结果
      return {
        query,
        results,
      };
    } catch (error) {
      logger.error({ error }, "Search process error");

      try {
        // 尝试保存浏览器状态，即使发生错误
        if (!noSaveState) {
          logger.info({ stateFile }, "Saving browser state...");
          const stateDir = path.dirname(stateFile);
          if (!fs.existsSync(stateDir)) {
            fs.mkdirSync(stateDir, { recursive: true });
          }
          await context.storageState({ path: stateFile });

          // 保存指纹配置
          try {
            fs.writeFileSync(
              fingerprintFile,
              JSON.stringify(savedState, null, 2),
              "utf8"
            );
            logger.info({ fingerprintFile }, "Fingerprint configuration saved");
          } catch (fingerprintError) {
            logger.error({ error: fingerprintError }, "Error saving fingerprint configuration");
          }
        }
      } catch (stateError) {
        logger.error({ error: stateError }, "Error saving browser state");
      }

      // 只有在浏览器不是外部提供的情况下才关闭浏览器
      if (!browserWasProvided) {
        logger.info("Closing browser...");
        await browser.close();
      } else {
        logger.info("Keeping browser instance open");
      }

      // 创建一个模拟的搜索结果，以便在出错时仍能返回一些信息
      return {
        query,
        results: [
          {
            title: "Search failed",
            link: "",
            snippet: `Unable to complete search, error message: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
        ],
      };
    }
  }

  // 首先尝试以无头模式执行搜索
  return performSearch(useHeadless);
}
