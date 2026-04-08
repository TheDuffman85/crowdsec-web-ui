import { Modal } from './ui/Modal';
import type { SearchHelpDefinition } from '../../../shared/search';

interface SearchSyntaxModalProps {
  help: SearchHelpDefinition;
  isOpen: boolean;
  onClose: () => void;
  onSelectExample?: (query: string) => void;
}

export function SearchSyntaxModal({ help, isOpen, onClose, onSelectExample }: SearchSyntaxModalProps) {
  return (
    <Modal isOpen={isOpen} onClose={onClose} title={help.title} maxWidth="max-w-3xl">
      <div className="space-y-6 text-sm text-gray-700 dark:text-gray-200">
        <p className="leading-6">{help.summary}</p>

        <section className="space-y-3">
          <h4 className="text-base font-semibold text-gray-900 dark:text-white">Supported Fields</h4>
          <div className="rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
            <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
              <thead className="bg-gray-50 dark:bg-gray-900/50">
                <tr>
                  <th className="px-4 py-2 text-left text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">Field</th>
                  <th className="px-4 py-2 text-left text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">Description</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200 dark:divide-gray-700 bg-white dark:bg-gray-800">
                {help.fields.map((field) => (
                  <tr key={field.name}>
                    <td className="px-4 py-2 align-top font-mono text-xs text-gray-900 dark:text-gray-100">
                      {field.name}
                      {field.aliases.length > 0 && (
                        <span className="ml-2 text-gray-500 dark:text-gray-400">
                          ({field.aliases.join(', ')})
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2 align-top">{field.description}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="space-y-3">
          <h4 className="text-base font-semibold text-gray-900 dark:text-white">Examples</h4>
          <div className="space-y-2">
            {help.examples.map((example) => (
              <button
                type="button"
                key={example.query}
                onClick={() => onSelectExample?.(example.query)}
                className="block w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/40 px-4 py-3 text-left transition-colors hover:bg-gray-100 dark:hover:bg-gray-900/70 focus:outline-none focus:ring-2 focus:ring-primary-500"
              >
                <div className="font-mono text-xs text-primary-700 dark:text-primary-300">{example.query}</div>
                <div className="mt-1 text-sm text-gray-600 dark:text-gray-300">{example.description}</div>
              </button>
            ))}
          </div>
        </section>
      </div>
    </Modal>
  );
}
