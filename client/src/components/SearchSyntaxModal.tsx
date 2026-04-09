import type { ReactNode } from 'react';
import { Modal } from './ui/Modal';
import type { SearchFeatureFlags, SearchHelpDefinition } from '../../../shared/search';
import { InlineSearchQueryHighlight, SearchQueryHighlight } from './HighlightedSearchInput';

interface SearchSyntaxModalProps {
  help: SearchHelpDefinition;
  searchFeatures?: SearchFeatureFlags;
  isOpen: boolean;
  onClose: () => void;
  onSelectExample?: (query: string) => void;
  onInsertSnippet?: (snippet: string) => void;
}

export function SearchSyntaxModal({
  help,
  searchFeatures,
  isOpen,
  onClose,
  onSelectExample,
  onInsertSnippet,
}: SearchSyntaxModalProps) {
  const handleInsertSnippet = (snippet: string) => {
    onInsertSnippet?.(snippet);
  };

  const handleSelectExample = (query: string) => {
    onSelectExample?.(query);
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={help.title} maxWidth="max-w-3xl">
      <div className="space-y-6 text-sm text-gray-700 dark:text-gray-200">
        <div className="space-y-3">
          <p className="leading-6">{renderInlineCode(help.summary, help.page, searchFeatures)}</p>
          <ul className="space-y-2 text-sm text-gray-600 dark:text-gray-300">
            {help.tips.map((tip) => (
              <li key={tip} className="flex gap-2">
                <span className="mt-1 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-primary-500" aria-hidden="true" />
                <span>{renderInlineCode(tip, help.page, searchFeatures)}</span>
              </li>
            ))}
          </ul>
        </div>

        <section className="space-y-3">
          <h4 className="text-base font-semibold text-gray-900 dark:text-white">Operators</h4>
          <div className="grid gap-2 sm:grid-cols-2">
            {help.operators.map((operator) => (
              <button
                type="button"
                key={operator.label}
                onClick={() => handleInsertSnippet(operator.insertText)}
                className="flex cursor-pointer items-start gap-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/40 px-4 py-3 text-left transition-colors hover:border-primary-300 hover:bg-gray-100 dark:hover:border-primary-700 dark:hover:bg-gray-900/70 focus:outline-none focus:ring-2 focus:ring-primary-500"
              >
                <span className="min-w-[2.5rem] rounded-md border border-primary-200 bg-white px-2 py-1 text-center font-mono text-xs font-semibold text-primary-700 shadow-sm dark:border-primary-900 dark:bg-gray-800 dark:text-primary-300">
                  {operator.label}
                </span>
                <span className="text-sm text-gray-600 dark:text-gray-300">
                  {renderInlineCode(operator.description, help.page, searchFeatures)}
                </span>
              </button>
            ))}
          </div>
        </section>

        <section className="space-y-3">
          <h4 className="text-base font-semibold text-gray-900 dark:text-white">Supported Fields</h4>
          <div className="grid gap-2 sm:grid-cols-2">
            {help.fields.map((field) => (
              <button
                type="button"
                key={field.name}
                onClick={() => handleInsertSnippet(field.name)}
                className="flex cursor-pointer items-start gap-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/40 px-4 py-3 text-left transition-colors hover:border-primary-300 hover:bg-gray-100 dark:hover:border-primary-700 dark:hover:bg-gray-900/70 focus:outline-none focus:ring-2 focus:ring-primary-500"
                aria-label={`Insert field ${field.name}`}
              >
                <span className="min-w-[2.5rem] rounded-md border border-primary-200 bg-white px-2 py-1 text-center font-mono text-xs font-semibold text-primary-700 shadow-sm dark:border-primary-900 dark:bg-gray-800 dark:text-primary-300">
                  {field.name}
                </span>
                <span className="text-sm text-gray-600 dark:text-gray-300">
                  {renderInlineCode(field.description, help.page, searchFeatures)}
                  {field.aliases.length > 0 && (
                    <span className="text-xs text-gray-500 dark:text-gray-400">
                      {' '}Aliases:{' '}
                      {field.aliases.map((alias, index) => (
                        <span key={alias}>
                          {index > 0 && ', '}
                          <code className="rounded bg-gray-100 px-1 py-0.5 font-mono text-[11px] text-gray-700 dark:bg-gray-700/60 dark:text-gray-200">
                            {alias}
                          </code>
                        </span>
                      ))}
                    </span>
                  )}
                </span>
              </button>
            ))}
          </div>
        </section>

        <section className="space-y-3">
          <h4 className="text-base font-semibold text-gray-900 dark:text-white">Examples</h4>
          <div className="space-y-2">
            {help.examples.map((example) => (
              <button
                type="button"
                key={example.query}
                onClick={() => handleSelectExample(example.query)}
                className="block w-full cursor-pointer rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/40 px-4 py-3 text-left transition-colors hover:border-primary-300 hover:bg-gray-100 dark:hover:border-primary-700 dark:hover:bg-gray-900/70 focus:outline-none focus:ring-2 focus:ring-primary-500"
              >
                <span className="sr-only">{example.query}</span>
                <SearchQueryHighlight
                  query={example.query}
                  searchPage={help.page}
                  searchFeatures={searchFeatures}
                  ariaHidden
                  className="font-mono text-xs leading-5 whitespace-pre-wrap break-words"
                />
                <div className="mt-1 text-sm text-gray-600 dark:text-gray-300">
                  {renderInlineCode(example.description, help.page, searchFeatures)}
                </div>
              </button>
            ))}
          </div>
        </section>
      </div>
    </Modal>
  );
}

function renderInlineCode(
  text: string,
  searchPage: SearchHelpDefinition['page'],
  searchFeatures?: SearchFeatureFlags,
): ReactNode {
  const segments = text.split(/(`[^`]+`)/g).filter(Boolean);

  return segments.map((segment, index) => {
    if (segment.startsWith('`') && segment.endsWith('`')) {
      return (
        <code
          key={`${segment}-${index}`}
          className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-[0.95em] dark:bg-gray-700/70"
        >
          <InlineSearchQueryHighlight
            query={segment.slice(1, -1)}
            searchPage={searchPage}
            searchFeatures={searchFeatures}
          />
        </code>
      );
    }

    return <span key={`${segment}-${index}`}>{segment}</span>;
  });
}
