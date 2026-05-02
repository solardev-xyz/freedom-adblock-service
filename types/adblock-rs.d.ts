declare module 'adblock-rs' {
  /// Subset of the adblock-rs API used by this service.
  /// Upstream ships no .d.ts; full surface lives at js/index.js.

  export interface ContentBlockingTrigger {
    'url-filter': string;
    'url-filter-is-case-sensitive'?: boolean;
    'if-domain'?: string[];
    'unless-domain'?: string[];
    'resource-type'?: string[];
    'load-type'?: string[];
  }

  export interface ContentBlockingAction {
    type: 'block' | 'block-cookies' | 'css-display-none' | 'ignore-previous-rules';
    selector?: string;
  }

  export interface ContentBlockingRule {
    trigger: ContentBlockingTrigger;
    action: ContentBlockingAction;
  }

  /// Header metadata parsed from `! Title:`, `! Homepage:`, etc. comment lines.
  /// `expires` is a Rust enum (`{Days: 4}` etc.), not a plain string — left as
  /// unknown since we just pass it through to metadata.json verbatim.
  export interface FilterListMetadata {
    title: string | null;
    homepage: string | null;
    expires: unknown;
    redirect: string | null;
  }

  export interface ContentBlockingResult {
    contentBlockingRules: ContentBlockingRule[];
    filtersUsed: string[];
  }

  export class FilterSet {
    constructor(debug?: boolean);
    addFilters(rules: string[]): FilterListMetadata;
    addFilter(rule: string): FilterListMetadata;
    intoContentBlocking(): ContentBlockingResult | undefined;
  }
}
