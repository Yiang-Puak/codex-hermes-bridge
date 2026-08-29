export function resolveWindowsPathToWsl(input: string): string {
  if (input.startsWith("/")) return input;

  const match = /^([A-Za-z]):[\\/](.*)$/.exec(input);
  if (!match) {
    throw new Error(`Cannot convert Windows path to WSL path: ${input}`);
  }

  const drive = match[1]?.toLowerCase();
  const rest = match[2]?.replaceAll("\\", "/");
  if (!drive || rest === undefined) {
    throw new Error(`Cannot convert Windows path to WSL path: ${input}`);
  }
  return `/mnt/${drive}/${rest}`;
}
