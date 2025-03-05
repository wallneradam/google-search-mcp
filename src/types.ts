/**
 * Search result interface
 */
export interface SearchResult {
  title: string;
  link: string;
  snippet: string;
}

/**
 * Search response interface
 */
export interface SearchResponse {
  query: string;
  results: SearchResult[];
}

/**
 * Command line options interface
 */
export interface CommandOptions {
  limit?: number;
  timeout?: number;
  headless?: boolean; // Deprecated, but kept for compatibility with existing code
  stateFile?: string;
  noSaveState?: boolean;
  locale?: string; // Search results language, default is Chinese(zh-CN)
}
