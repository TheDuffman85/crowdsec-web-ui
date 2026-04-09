import {
  forwardRef,
  useEffect,
  useMemo,
  useRef,
  type ChangeEventHandler,
  type InputHTMLAttributes,
  type KeyboardEventHandler,
  type MouseEventHandler,
  type ReactNode,
  type Ref,
  type UIEventHandler,
} from 'react';
import { Search } from 'lucide-react';
import {
  analyzeSearchQuery,
  type SearchFeatureFlags,
  type SearchHighlightTokenKind,
  type SearchPage,
  type SearchParseError,
} from '../../../shared/search';

type HighlightedSearchInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & {
  searchPage: SearchPage;
  searchFeatures?: SearchFeatureFlags;
  error?: SearchParseError | null;
};

interface SearchQueryHighlightProps {
  query: string;
  searchPage: SearchPage;
  searchFeatures?: SearchFeatureFlags;
  error?: SearchParseError | null;
  highlightErrors?: boolean;
  ariaHidden?: boolean;
  className?: string;
}

interface HighlightSegment {
  key: string;
  text: string;
  kind: SearchHighlightTokenKind | 'plain';
  hasError: boolean;
}

export const SearchQueryHighlight = forwardRef<HTMLDivElement, SearchQueryHighlightProps>(
  function SearchQueryHighlight(
    {
      query,
      searchPage,
      searchFeatures,
      error,
      highlightErrors = false,
      ariaHidden,
      className = '',
    },
    ref,
  ) {
    const segments = useSearchHighlightSegments(query, searchPage, searchFeatures, error, highlightErrors);

    return (
      <div ref={ref} className={className} aria-hidden={ariaHidden} data-search-highlight-layer="true">
        {renderHighlightSegments(segments)}
      </div>
    );
  },
);

export function InlineSearchQueryHighlight({
  query,
  searchPage,
  searchFeatures,
  error,
  highlightErrors = false,
  ariaHidden,
  className = '',
}: SearchQueryHighlightProps) {
  const segments = useSearchHighlightSegments(query, searchPage, searchFeatures, error, highlightErrors);

  return (
    <span className={className} aria-hidden={ariaHidden} data-search-highlight-layer="true">
      {renderHighlightSegments(segments)}
    </span>
  );
}

export const HighlightedSearchInput = forwardRef<HTMLInputElement, HighlightedSearchInputProps>(
  function HighlightedSearchInput(
    {
      searchPage,
      searchFeatures,
      error,
      value = '',
      className = '',
      onChange,
      onClick,
      onKeyUp,
      onScroll,
      onSelect,
      ...inputProps
    },
    ref,
  ) {
    const inputRef = useRef<HTMLInputElement | null>(null);
    const highlightRef = useRef<HTMLDivElement | null>(null);
    const query = String(value);
    const { error: analysisError } = useMemo(
      () => analyzeSearchQuery(query, searchPage, searchFeatures),
      [searchFeatures, searchPage, query],
    );
    const activeError = error ?? analysisError;

    const syncScroll = (scrollLeft: number) => {
      if (highlightRef.current) {
        highlightRef.current.style.transform = `translateX(-${scrollLeft}px)`;
      }
    };

    useEffect(() => {
      syncScroll(inputRef.current?.scrollLeft ?? 0);
    }, [value]);

    const handleChange: ChangeEventHandler<HTMLInputElement> = (event) => {
      syncScroll(event.currentTarget.scrollLeft);
      onChange?.(event);
    };

    const handleClick: MouseEventHandler<HTMLInputElement> = (event) => {
      syncScroll(event.currentTarget.scrollLeft);
      onClick?.(event);
    };

    const handleKeyUp: KeyboardEventHandler<HTMLInputElement> = (event) => {
      syncScroll(event.currentTarget.scrollLeft);
      onKeyUp?.(event);
    };

    const handleSelect: UIEventHandler<HTMLInputElement> = (event) => {
      syncScroll(event.currentTarget.scrollLeft);
      onSelect?.(event);
    };

    const handleScroll: UIEventHandler<HTMLInputElement> = (event) => {
      syncScroll(event.currentTarget.scrollLeft);
      onScroll?.(event);
    };

    return (
      <div
        className={`relative rounded-md border bg-white dark:bg-gray-800 ${
          activeError
            ? 'border-red-300 dark:border-red-700 focus-within:border-red-500 focus-within:ring-1 focus-within:ring-red-500'
            : 'border-gray-300 dark:border-gray-700 focus-within:border-primary-500 focus-within:ring-1 focus-within:ring-primary-500'
        }`}
      >
        <div className="pointer-events-none absolute inset-y-0 left-0 z-20 flex items-center pl-3">
          <Search className="h-5 w-5 text-gray-400" />
        </div>
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden rounded-md">
          <div className="absolute inset-y-0 left-0 right-0 overflow-hidden px-3 py-2 pl-10 font-mono text-sm leading-5">
            <SearchQueryHighlight
              ref={highlightRef}
              query={query}
              searchPage={searchPage}
              searchFeatures={searchFeatures}
              error={error}
              highlightErrors
              className="min-w-full whitespace-pre text-gray-900 dark:text-gray-100"
            />
          </div>
        </div>
        <input
          {...inputProps}
          ref={(node) => {
            inputRef.current = node;
            assignRef(ref, node);
          }}
          type="text"
          value={value}
          onChange={handleChange}
          onClick={handleClick}
          onKeyUp={handleKeyUp}
          onSelect={handleSelect}
          onScroll={handleScroll}
          className={`relative z-10 block w-full rounded-md border-0 bg-transparent py-2 pl-10 pr-3 font-mono text-sm leading-5 text-transparent caret-gray-900 placeholder-gray-500 focus:outline-none focus:ring-0 dark:caret-gray-100 dark:placeholder-gray-400 selection:bg-primary-100 dark:selection:bg-primary-900/60 ${className}`}
          style={{ WebkitTextFillColor: 'transparent' }}
          spellCheck={false}
          autoComplete="off"
        />
      </div>
    );
  },
);

function useSearchHighlightSegments(
  query: string,
  searchPage: SearchPage,
  searchFeatures: SearchFeatureFlags | undefined,
  error: SearchParseError | null | undefined,
  highlightErrors: boolean,
): HighlightSegment[] {
  const analysis = useMemo(
    () => analyzeSearchQuery(query, searchPage, searchFeatures),
    [query, searchFeatures, searchPage],
  );
  const activeError = highlightErrors ? (error ?? analysis.error) : null;

  return useMemo(
    () => buildHighlightSegments(query, analysis.tokens, activeError),
    [activeError, analysis.tokens, query],
  );
}

function renderHighlightSegments(segments: HighlightSegment[]): ReactNode {
  return segments.map((segment) => (
    <span
      key={segment.key}
      data-search-highlight-kind={segment.kind}
      data-search-highlight-error={segment.hasError ? 'true' : 'false'}
      className={getSegmentClassName(segment.kind, segment.hasError)}
    >
      {segment.text}
    </span>
  ));
}

function buildHighlightSegments(
  query: string,
  tokens: ReturnType<typeof analyzeSearchQuery>['tokens'],
  error: SearchParseError | null,
): HighlightSegment[] {
  if (!query) {
    return [];
  }

  const boundaries = new Set<number>([0, query.length]);
  for (const token of tokens) {
    boundaries.add(token.start);
    boundaries.add(token.end);
  }
  if (error) {
    boundaries.add(error.position);
    boundaries.add(Math.min(query.length, error.position + Math.max(error.length, 1)));
  }

  const orderedBoundaries = Array.from(boundaries)
    .filter((boundary) => boundary >= 0 && boundary <= query.length)
    .sort((left, right) => left - right);
  const segments: HighlightSegment[] = [];

  for (let index = 0; index < orderedBoundaries.length - 1; index += 1) {
    const start = orderedBoundaries[index];
    const end = orderedBoundaries[index + 1];
    if (start === end) {
      continue;
    }

    const text = query.slice(start, end);
    const token = tokens.find((candidate) => candidate.start <= start && candidate.end >= end);
    const errorEnd = error ? Math.min(query.length, error.position + Math.max(error.length, 1)) : -1;
    const hasError = error !== null && start < errorEnd && end > error.position;

    segments.push({
      key: `${start}-${end}-${token?.kind ?? 'plain'}-${hasError ? 'error' : 'ok'}`,
      text,
      kind: token?.kind ?? 'plain',
      hasError,
    });
  }

  return segments;
}

function assignRef<T>(ref: Ref<T> | undefined, value: T | null): void {
  if (!ref) {
    return;
  }
  if (typeof ref === 'function') {
    ref(value);
    return;
  }
  ref.current = value;
}

function getSegmentClassName(kind: HighlightSegment['kind'], hasError: boolean): string {
  const errorClassName = hasError ? 'rounded bg-red-100/90 text-red-900 dark:bg-red-900/40 dark:text-red-200' : '';

  switch (kind) {
    case 'field':
      return `font-semibold text-sky-700 dark:text-sky-300 ${errorClassName}`.trim();
    case 'booleanOperator':
      return `font-semibold text-violet-700 dark:text-violet-300 ${errorClassName}`.trim();
    case 'comparator':
      return `font-semibold text-amber-700 dark:text-amber-300 ${errorClassName}`.trim();
    case 'string':
      return `text-emerald-700 dark:text-emerald-300 ${errorClassName}`.trim();
    case 'paren':
    case 'negation':
      return `text-gray-500 dark:text-gray-400 ${errorClassName}`.trim();
    case 'term':
    case 'plain':
    default:
      return `text-gray-900 dark:text-gray-100 ${errorClassName}`.trim();
  }
}
