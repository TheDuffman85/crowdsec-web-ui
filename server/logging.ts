const TIMESTAMPED_CONSOLE_KEY = Symbol.for('crowdsec-web-ui.timestamped-console');

type ConsoleWriter = (...args: unknown[]) => void;

export function installTimestampedConsole(): void {
  const globalState = globalThis as typeof globalThis & { [TIMESTAMPED_CONSOLE_KEY]?: boolean };
  if (globalState[TIMESTAMPED_CONSOLE_KEY]) return;
  globalState[TIMESTAMPED_CONSOLE_KEY] = true;

  console.log = timestampWriter(console.log.bind(console));
  console.info = timestampWriter(console.info.bind(console));
  console.warn = timestampWriter(console.warn.bind(console));
  console.error = timestampWriter(console.error.bind(console));
  console.debug = timestampWriter(console.debug.bind(console));
}

function timestampWriter(writer: ConsoleWriter): ConsoleWriter {
  return (...args: unknown[]) => {
    const timestamp = `[${new Date().toISOString()}]`;
    writer(timestamp, ...prefixMultilineLogArguments(args, timestamp));
  };
}

export function prefixMultilineLogArguments(args: unknown[], prefix: string): unknown[] {
  return args.map((argument) => (
    typeof argument === 'string'
      ? argument.replace(/\n/g, `\n${prefix} `)
      : argument
  ));
}
