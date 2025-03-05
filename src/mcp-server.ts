#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { googleSearch } from "./search.js";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import logger from "./logger.js";
import { chromium, Browser } from "playwright";

// Global browser instance
let globalBrowser: Browser | undefined = undefined;

// Create MCP server instance
const server = new McpServer({
  name: "google-search-server",
  version: "1.0.0",
});

// Register Google search tool
server.tool(
  "google-search",
  "Use Google search engine to query real-time web information, returning search results including titles, links, and summaries. Suitable for obtaining the latest information, finding specific topic materials, researching current events, or verifying facts. Results are returned in JSON format, including query content and a list of matching results.",
  {
    query: z
      .string()
      .describe(
        "Search query string. For best results: 1) Use specific keywords rather than vague phrases; 2) Use quotes \"exact phrase\" for exact matching; 3) Use site:domain to limit to specific websites; 4) Use -word to filter out results; 5) Use OR to connect alternative words; 6) Prioritize technical terms; 7) Keep to 2-5 keywords for balanced results. For example: 'climate change research report 2024 site:gov -opinion' or '\"machine learning algorithms\" tutorial (Python OR Julia)'"
      ),
    limit: z
      .number()
      .optional()
      .describe("Number of search results to return (default: 10, recommended range: 1-20)"),
    timeout: z
      .number()
      .optional()
      .describe("Timeout for search operation in milliseconds (default: 30000, can be adjusted based on network conditions)"),
  },
  async (params) => {
    try {
      const { query, limit, timeout } = params;
      logger.info({ query }, "Executing Google search");

      // Get the state file path in the user's home directory
      const stateFilePath = path.join(
        os.homedir(),
        ".google-search-browser-state.json"
      );
      logger.info({ stateFilePath }, "Using state file path");

      // Check if the state file exists
      const stateFileExists = fs.existsSync(stateFilePath);

      // Initialize warning message
      let warningMessage = "";

      if (!stateFileExists) {
        warningMessage =
          "⚠️ Note: Browser state file does not exist. For first-time use, if you encounter CAPTCHA verification, the system will automatically switch to headed mode for you to complete verification. After completion, the system will save the state file, making subsequent searches smoother.";
        logger.warn(warningMessage);
      }

      // Use global browser instance to execute search
      const results = await googleSearch(
        query,
        {
          limit: limit,
          timeout: timeout,
          stateFile: stateFilePath,
        },
        globalBrowser
      );

      // Build return result, including warning message
      let responseText = JSON.stringify(results, null, 2);
      if (warningMessage) {
        responseText = warningMessage + "\n\n" + responseText;
      }

      return {
        content: [
          {
            type: "text",
            text: responseText,
          },
        ],
      };
    } catch (error) {
      logger.error({ error }, "Search tool execution error");

      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Search failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
        ],
      };
    }
  }
);

// Start the server
async function main() {
  try {
    logger.info("Starting Google Search MCP Server...");

    // Initialize global browser instance
    logger.info("Initializing global browser instance...");
    globalBrowser = await chromium.launch({
      headless: true,
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
    logger.info("Global browser instance initialized successfully");

    const transport = new StdioServerTransport();
    await server.connect(transport);

    logger.info("Google Search MCP Server started, waiting for connections...");

    // Set up cleanup function for process exit
    process.on("exit", async () => {
      await cleanupBrowser();
    });

    // Handle Ctrl+C (Windows and Unix/Linux)
    process.on("SIGINT", async () => {
      logger.info("Received SIGINT signal, shutting down server...");
      await cleanupBrowser();
      process.exit(0);
    });

    // Handle process termination (Unix/Linux)
    process.on("SIGTERM", async () => {
      logger.info("Received SIGTERM signal, shutting down server...");
      await cleanupBrowser();
      process.exit(0);
    });

    // Windows-specific handling
    if (process.platform === "win32") {
      // Handle Windows CTRL_CLOSE_EVENT, CTRL_LOGOFF_EVENT, and CTRL_SHUTDOWN_EVENT
      const readline = await import("readline");
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      rl.on("SIGINT", async () => {
        logger.info("Windows: Received SIGINT signal, shutting down server...");
        await cleanupBrowser();
        process.exit(0);
      });
    }
  } catch (error) {
    logger.error({ error }, "Server startup failed");
    await cleanupBrowser();
    process.exit(1);
  }
}

// Clean up browser resources
async function cleanupBrowser() {
  if (globalBrowser) {
    logger.info("Closing global browser instance...");
    try {
      await globalBrowser.close();
      globalBrowser = undefined;
      logger.info("Global browser instance closed");
    } catch (error) {
      logger.error({ error }, "Error closing browser instance");
    }
  }
}

main();
