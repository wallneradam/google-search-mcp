#!/usr/bin/env node

import { Command } from "commander";
import { googleSearch } from "./search.js";
import { CommandOptions } from "./types.js";

// Get package information
import packageJson from "../package.json" with { type: "json" };

// Create command line program
const program = new Command();

// Configure command line options
program
  .name("google-search")
  .description("Google Search CLI tool based on Playwright")
  .version(packageJson.version)
  .argument("<query>", "Search keywords")
  .option("-l, --limit <number>", "Result count limit", parseInt, 10)
  .option("-t, --timeout <number>", "Timeout in milliseconds", parseInt, 30000)
  .option("--no-headless", "Deprecated: Now always tries headless mode first, automatically switching to headed mode if CAPTCHA is encountered")
  .option("--state-file <path>", "Browser state file path", "./browser-state.json")
  .option("--no-save-state", "Don't save browser state")
  .action(async (query: string, options: CommandOptions) => {
    try {
      // Execute search
      const results = await googleSearch(query, options);

      // Output results
      console.log(JSON.stringify(results, null, 2));
    } catch (error) {
      console.error("Error:", error);
      process.exit(1);
    }
  });

// Parse command line arguments
program.parse(process.argv);
