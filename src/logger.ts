import { pino } from "pino";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";

// Use system temporary directory to ensure cross-platform compatibility
const logDir = path.join(os.tmpdir(), "google-search-logs");
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

// Create log file path
const logFilePath = path.join(logDir, "google-search.log");

// Create pino logger instance
const logger = pino({
  level: process.env.LOG_LEVEL || "info", // Log level can be set via environment variable
  transport: {
    targets: [
      // Output to console, using pino-pretty for formatting
      {
        target: "pino-pretty",
        level: "info",
        options: {
          colorize: true,
          translateTime: "SYS:yyyy-mm-dd HH:MM:ss",
          ignore: "pid,hostname",
        },
      },
      // Output to file - use trace level to capture all logs
      {
        target: "pino/file",
        level: "trace", // Use lowest level to capture all logs
        options: { destination: logFilePath },
      },
    ],
  },
});

// Add handler for process exit
process.on("exit", () => {
  logger.info("Process exiting, closing logs");
});

process.on("SIGINT", () => {
  logger.info("Received SIGINT signal, closing logs");
  process.exit(0);
});

process.on("SIGTERM", () => {
  logger.info("Received SIGTERM signal, closing logs");
  process.exit(0);
});

process.on("uncaughtException", (error) => {
  logger.error({ err: error }, "Uncaught exception");
  process.exit(1);
});

export default logger;
