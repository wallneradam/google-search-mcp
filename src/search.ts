import { chromium, devices, BrowserContextOptions, Browser } from "playwright";
import { SearchResponse, SearchResult, CommandOptions } from "./types.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import logger from "./logger.js";
import { url } from "inspector";

// Fingerprint configuration interface
interface FingerprintConfig {
  deviceName: string;
  locale: string;
  timezoneId: string;
  colorScheme: "dark" | "light";
  reducedMotion: "reduce" | "no-preference";
  forcedColors: "active" | "none";
}

// Saved state file interface
interface SavedState {
  fingerprint?: FingerprintConfig;
  googleDomain?: string;
}

/**
 * Get the actual configuration of the host machine
 * @param userLocale User-specified locale (if any)
 * @returns Fingerprint configuration based on the host machine
 */
function getHostMachineConfig(userLocale?: string): FingerprintConfig {
  // Get system locale
  const systemLocale = userLocale || process.env.LANG || "zh-CN";

  // Get system timezone
  // Node.js does not provide timezone information directly, but can infer it from the timezone offset
  const timezoneOffset = new Date().getTimezoneOffset();
  let timezoneId = "Asia/Shanghai"; // Default to Shanghai timezone

  // Roughly infer timezone based on timezone offset
  // The timezone offset is in minutes, relative to UTC, negative values indicate eastern regions
  if (timezoneOffset <= -480 && timezoneOffset > -600) {
    // UTC+8 (China, Singapore, Hong Kong, etc.)
    timezoneId = "Asia/Shanghai";
  } else if (timezoneOffset <= -540) {
    // UTC+9 (Japan, Korea, etc.)
    timezoneId = "Asia/Tokyo";
  } else if (timezoneOffset <= -420 && timezoneOffset > -480) {
    // UTC+7 (Thailand, Vietnam, etc.)
    timezoneId = "Asia/Bangkok";
  } else if (timezoneOffset <= 0 && timezoneOffset > -60) {
    // UTC+0 (UK, etc.)
    timezoneId = "Europe/London";
  } else if (timezoneOffset <= 60 && timezoneOffset > 0) {
    // UTC-1 (parts of Europe)
    timezoneId = "Europe/Berlin";
  } else if (timezoneOffset <= 180 && timezoneOffset > 60) {
    // UTC-2 (parts of Europe)
    timezoneId = "Europe/Budapest";
  } else if (timezoneOffset <= 300 && timezoneOffset > 240) {
    // UTC-5 (Eastern US)
    timezoneId = "America/New_York";
  }

  // Detect system color scheme
  // Node.js cannot directly get the system color scheme, using reasonable defaults
  // Can infer based on time: dark mode at night, light mode during the day
  const hour = new Date().getHours();
  const colorScheme =
    hour >= 19 || hour < 7 ? ("dark" as const) : ("light" as const);

  // Other settings use reasonable defaults
  const reducedMotion = "no-preference" as const; // Most users do not enable reduced motion
  const forcedColors = "none" as const; // Most users do not enable forced colors

  // Choose a suitable device name
  // Select appropriate browser based on the operating system
  const platform = os.platform();
  let deviceName = "Desktop Chrome"; // Default to Chrome

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

  // We use Chrome
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
 * Execute Google search and return results
 * @param query Search keywords
 * @param options Search options
 * @returns Search results
 */
export async function googleSearch(
  query: string,
  options: CommandOptions = {},
  existingBrowser?: Browser
): Promise<SearchResponse> {
  // Set default options
  const {
    limit = 10,
    timeout = 60000,
    stateFile = "./browser-state.json",
    noSaveState = false,
    locale = "hu-HU", // Default to Chinese
    headless = true, // Use headless parameter from command line options
  } = options;

  // Use headless parameter from command line options
  let useHeadless = headless;

  logger.info({ options }, "Executing Google search");

  // Check if state file exists
  let storageState: string | undefined = undefined;
  let savedState: SavedState = {};

  // Fingerprint configuration file path
  const fingerprintFile = stateFile.replace(".json", "-fingerprint.json");

  if (fs.existsSync(stateFile)) {
    logger.info(
      { stateFile },
      "Found browser state file, will use saved browser state to avoid robot detection"
    );
    storageState = stateFile;

    // Try to load saved fingerprint configuration
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

  // Only use desktop device list
  const deviceList = [
    "Desktop Chrome",
    "Desktop Edge",
    "Desktop Firefox",
    "Desktop Safari",
  ];

  // Timezone list
  const timezoneList = [
    "America/New_York",
    "Europe/London",
    "Asia/Shanghai",
    "Europe/Berlin",
    "Europe/Budapest",
    "Asia/Tokyo",
  ];

  // Google domain list
  const googleDomains = [
    "https://www.google.com",
    "https://www.google.co.uk",
    "https://www.google.ca",
    "https://www.google.com.au",
    "https://www.google.hu",
  ];

  // Get random device configuration or use saved configuration
  const getDeviceConfig = (): [string, any] => {
    if (
      savedState.fingerprint?.deviceName &&
      devices[savedState.fingerprint.deviceName]
    ) {
      // Use saved device configuration
      return [
        savedState.fingerprint.deviceName,
        devices[savedState.fingerprint.deviceName],
      ];
    } else {
      // Randomly select a device
      const randomDevice =
        deviceList[Math.floor(Math.random() * deviceList.length)];
      return [randomDevice, devices[randomDevice]];
    }
  };

  // Get random delay time
  const getRandomDelay = (min: number, max: number) => {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  };

  // Define a function to perform the search, reusable for headless and headed modes
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

      // Initialize browser, adding more parameters to avoid detection
      browser = await chromium.launch({
        headless,
        timeout: timeout * 2, // Increase browser startup timeout
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

    // Get device configuration - use saved or randomly generated
    const [deviceName, deviceConfig] = getDeviceConfig();

    // Create browser context options
    let contextOptions: BrowserContextOptions = {
      ...deviceConfig,
    };

    // If there is a saved fingerprint configuration, use it; otherwise use the actual settings of the host machine
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
      // Get actual settings of the host machine
      const hostConfig = getHostMachineConfig(locale);

      // If a different device type is needed, re-fetch device configuration
      if (hostConfig.deviceName !== deviceName) {
        logger.info(
          { deviceType: hostConfig.deviceName },
          "Using device type based on host machine settings"
        );
        // Use new device configuration
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

      // Save newly generated fingerprint configuration
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

    // Add common options - ensure desktop configuration is used
    contextOptions = {
      ...contextOptions,
      permissions: ["geolocation", "notifications"],
      acceptDownloads: true,
      isMobile: false, // Force desktop mode
      hasTouch: false, // Disable touch features
      javaScriptEnabled: true,
    };

    if (storageState) {
      logger.info("Loading saved browser state...");
    }

    const context = await browser.newContext(
      storageState ? { ...contextOptions, storageState } : contextOptions
    );

    // Set additional browser properties to avoid detection
    await context.addInitScript(() => {
      // Override navigator properties
      Object.defineProperty(navigator, "webdriver", { get: () => false });
      Object.defineProperty(navigator, "plugins", {
        get: () => [1, 2, 3, 4, 5],
      });
      Object.defineProperty(navigator, "languages", {
        get: () => ["en-US", "en", "zh-CN"],
      });

      // Override window properties
      // @ts-ignore - Ignore error for non-existent chrome property
      window.chrome = {
        runtime: {},
        loadTimes: function () { },
        csi: function () { },
        app: {},
      };

      // Add WebGL fingerprint randomization
      if (typeof WebGLRenderingContext !== "undefined") {
        const getParameter = WebGLRenderingContext.prototype.getParameter;
        WebGLRenderingContext.prototype.getParameter = function (
          parameter: number
        ) {
          // Randomize UNMASKED_VENDOR_WEBGL and UNMASKED_RENDERER_WEBGL
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

    // Set additional page properties
    await page.addInitScript(() => {
      // Simulate real screen size and color depth
      Object.defineProperty(window.screen, "width", { get: () => 1920 });
      Object.defineProperty(window.screen, "height", { get: () => 1080 });
      Object.defineProperty(window.screen, "colorDepth", { get: () => 24 });
      Object.defineProperty(window.screen, "pixelDepth", { get: () => 24 });
    });

    try {
      // Use saved Google domain or randomly select one
      let selectedDomain: string;
      if (savedState.googleDomain) {
        selectedDomain = savedState.googleDomain;
        logger.info({ domain: selectedDomain }, "Using saved Google domain");
      } else {
        selectedDomain =
          googleDomains[Math.floor(Math.random() * googleDomains.length)];
        // Save selected domain
        savedState.googleDomain = selectedDomain;
        logger.info({ domain: selectedDomain }, "Randomly selected Google domain");
      }

      logger.info("Accessing Google search page...");

      // Access Google search page
      const response = await page.goto(selectedDomain, {
        timeout,
        waitUntil: "networkidle",
      });

      // Handle cookie consent dialog
      try {
        // Try to find and click the cookie accept button
        const cookieAcceptSelectors = [
          "button[id='L2AGLb']",
          "button.tHlp8d",
          "div.QS5gu.sy4vM",
        ];

        for (const selector of cookieAcceptSelectors) {
          const cookieButton = await page.$(selector);
          if (cookieButton) {
            logger.info({ selector }, "Found cookie consent button, clicking it");
            await cookieButton.click();
            await page.waitForTimeout(1000);
            break;
          }
        }
      } catch (e) {
        logger.warn({ error: e }, "Error handling cookie consent, will continue anyway");
      }

      // Check if redirected to human verification page
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

          // Close current page and context
          await page.close();
          await context.close();

          // If it's an externally provided browser, do not close it, but create a new browser instance
          if (browserWasProvided) {
            logger.info(
              "Using external browser instance when encountering blocked page, creating new browser instance..."
            );
            // Create a new browser instance, no longer using the externally provided instance
            const newBrowser = await chromium.launch({
              headless: false, // Use headed mode
              timeout: timeout * 2,
              args: [
                "--disable-blink-features=AutomationControlled",
                // Other parameters remain the same
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

            // Use the new browser instance to perform the search
            try {
              const tempContext = await newBrowser.newContext(contextOptions);
              const tempPage = await tempContext.newPage();

              // Here you can add code to handle human verification
              // ...

              // Close temporary browser after completion
              await newBrowser.close();

              // Re-execute search
              return performSearch(false);
            } catch (error) {
              await newBrowser.close();
              throw error;
            }
          } else {
            // If not an externally provided browser, close and re-execute search
            await browser.close();
            return performSearch(false); // Re-execute search in headed mode
          }
        } else {
          logger.warn("Detected blocked page, please complete verification in the browser...");
          // Wait for user to complete verification and redirect back to search page
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

      // Wait for search input to appear - try multiple possible selectors
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

      // Directly click the search box to reduce delay
      await searchInput.click();

      // Directly input the entire query string instead of typing character by character
      await page.keyboard.type(query, { delay: getRandomDelay(10, 30) });

      // Reduce delay before pressing enter
      await page.waitForTimeout(getRandomDelay(100, 300));
      await page.keyboard.press("Enter");

      logger.info("Waiting for page load to complete...");

      // Wait for page to load completely
      await page.waitForLoadState("networkidle", { timeout });

      // Check if the URL after search is redirected to the human verification page
      const searchUrl = page.url();
      const isBlockedAfterSearch = sorryPatterns.some((pattern) =>
        searchUrl.includes(pattern)
      );

      if (isBlockedAfterSearch) {
        if (headless) {
          logger.warn(
            "Detected blocked page after search, will restart browser in headed mode..."
          );

          // Close current page and context
          await page.close();
          await context.close();

          // If it's an externally provided browser, do not close it, but create a new browser instance
          if (browserWasProvided) {
            logger.info(
              "Using external browser instance when encountering blocked page after search, creating new browser instance..."
            );
            // Create a new browser instance, no longer using the externally provided instance
            const newBrowser = await chromium.launch({
              headless: false, // Use headed mode
              timeout: timeout * 2,
              args: [
                "--disable-blink-features=AutomationControlled",
                // Other parameters remain the same
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

            // Use the new browser instance to perform the search
            try {
              const tempContext = await newBrowser.newContext(contextOptions);
              const tempPage = await tempContext.newPage();

              // Here you can add code to handle human verification
              // ...

              // Close temporary browser after completion
              await newBrowser.close();

              // Re-execute search
              return performSearch(false);
            } catch (error) {
              await newBrowser.close();
              throw error;
            }
          } else {
            // If not an externally provided browser, close and re-execute search
            await browser.close();
            return performSearch(false); // Re-execute search in headed mode
          }
        } else {
          logger.warn("Detected blocked page after search, please complete verification in the browser...");
          // Wait for user to complete verification and redirect back to search page
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

          // Wait for the page to reload
          await page.waitForLoadState("networkidle", { timeout });
        }
      }

      logger.info({ url: page.url() }, "Waiting for search results to load...");

      // Try multiple possible search result selectors
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
          // Continue trying the next selector
        }
      }

      if (!resultsFound) {
        // If no search results found, check if redirected to human verification page
        const currentUrl = page.url();
        const isBlockedDuringResults = sorryPatterns.some((pattern) =>
          currentUrl.includes(pattern)
        );

        if (isBlockedDuringResults) {
          if (headless) {
            logger.warn(
              "Detected blocked page during search results, will restart browser in headed mode..."
            );

            // Close current page and context
            await page.close();
            await context.close();

            // If it's an externally provided browser, do not close it, but create a new browser instance
            if (browserWasProvided) {
              logger.info(
                "Using external browser instance when encountering blocked page during search results, creating new browser instance..."
              );
              // Create a new browser instance, no longer using the externally provided instance
              const newBrowser = await chromium.launch({
                headless: false, // Use headed mode
                timeout: timeout * 2,
                args: [
                  "--disable-blink-features=AutomationControlled",
                  // Other parameters remain the same
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

              // Use the new browser instance to perform the search
              try {
                const tempContext = await newBrowser.newContext(contextOptions);
                const tempPage = await tempContext.newPage();

                // Here you can add code to handle human verification
                // ...

                // Close temporary browser after completion
                await newBrowser.close();

                // Re-execute search
                return performSearch(false);
              } catch (error) {
                await newBrowser.close();
                throw error;
              }
            } else {
              // If not an externally provided browser, close and re-execute search
              await browser.close();
              return performSearch(false); // Re-execute search in headed mode
            }
          } else {
            logger.warn(
              "Detected blocked page during search results, please complete verification in the browser..."
            );
            // Wait for user to complete verification and redirect back to search page
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

            // Try waiting for search results again
            for (const selector of searchResultSelectors) {
              try {
                await page.waitForSelector(selector, { timeout: timeout / 2 });
                logger.info({ selector }, "Verified and found search result");
                resultsFound = true;
                break;
              } catch (e) {
                // Continue trying the next selector
              }
            }

            if (!resultsFound) {
              logger.error("Unable to find search result element");
              throw new Error("Unable to find search result element");
            }
          }
        } else {
          // If not a human verification issue, throw an error
          logger.error("Unable to find search result element");
          throw new Error("Unable to find search result element");
        }
      }

      // Reduce wait time
      await page.waitForTimeout(getRandomDelay(200, 500));

      logger.info("Extracting search results...");

      // Extract search results - try various selector combinations
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
                ); // Filter out empty results
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
          // Continue trying the next selector combination
        }
      }

      // If all selectors fail, try a more generic method
      if (results.length === 0) {
        logger.info("Using fallback method to extract search results...");
        results = await page.$$eval(
          "a[href^='http']",
          (elements: Element[], maxResults: number) => {
            return elements
              .filter((el: Element) => {
                // Filter out navigation links, image links, etc.
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
                // Try to get surrounding text as a snippet
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
              ); // Filter out empty results
          },
          limit
        );
      }

      logger.info({ count: results.length }, "Successfully retrieved search results");

      try {
        // Save browser state (unless user specified not to save)
        if (!noSaveState) {
          logger.info({ stateFile }, "Saving browser state...");

          // Ensure directory exists
          const stateDir = path.dirname(stateFile);
          if (!fs.existsSync(stateDir)) {
            fs.mkdirSync(stateDir, { recursive: true });
          }

          // Save state
          await context.storageState({ path: stateFile });
          logger.info("Browser state saved successfully!");

          // Save fingerprint configuration
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

      // Only close the browser if it is not externally provided
      if (!browserWasProvided) {
        logger.info("Closing browser...");
        await browser.close();
      } else {
        logger.info("Keeping browser instance open");
      }

      // Return search results
      return {
        query,
        results,
      };
    } catch (error) {
      logger.error({ error }, "Search process error");

      try {
        // Try to save browser state even if an error occurs
        if (!noSaveState) {
          logger.info({ stateFile }, "Saving browser state...");
          const stateDir = path.dirname(stateFile);
          if (!fs.existsSync(stateDir)) {
            fs.mkdirSync(stateDir, { recursive: true });
          }
          await context.storageState({ path: stateFile });

          // Save fingerprint configuration
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

      // Only close the browser if it is not externally provided
      if (!browserWasProvided) {
        logger.info("Closing browser...");
        await browser.close();
      } else {
        logger.info("Keeping browser instance open");
      }

      // Create a mock search result to return some information in case of error
      return {
        query,
        results: [
          {
            title: "Search failed",
            link: "",
            snippet: `Unable to complete search, error message: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }

  // First, try to perform the search in headless mode
  return performSearch(useHeadless);
}
