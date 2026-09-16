/** Git global options precede the command; their values are not subcommands. */
function gitCommandIndex(args: readonly string[]): number {
  const valueOptions = new Set([
    "-C",
    "-c",
    "--git-dir",
    "--work-tree",
    "--namespace",
    "--config-env",
    "--super-prefix",
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (valueOptions.has(argument)) {
      index += 1;
    } else if (!argument.startsWith("-")) {
      return index;
    }
  }
  return -1;
}

const LOCAL_GIT_COMMANDS = new Set([
  "add",
  "am",
  "apply",
  "bisect",
  "blame",
  "branch",
  "bundle",
  "cat-file",
  "check-attr",
  "check-ignore",
  "check-mailmap",
  "check-ref-format",
  "checkout",
  "checkout-index",
  "cherry",
  "cherry-pick",
  "clean",
  "commit",
  "commit-tree",
  "config",
  "count-objects",
  "describe",
  "diff",
  "diff-files",
  "diff-index",
  "diff-tree",
  "for-each-ref",
  "format-patch",
  "fsck",
  "gc",
  "hash-object",
  "init",
  "log",
  "ls-files",
  "ls-tree",
  "merge",
  "merge-base",
  "merge-file",
  "merge-tree",
  "mv",
  "name-rev",
  "notes",
  "prune",
  "read-tree",
  "rebase",
  "reflog",
  "repack",
  "replace",
  "reset",
  "restore",
  "rev-list",
  "rev-parse",
  "revert",
  "rm",
  "show",
  "show-ref",
  "stash",
  "status",
  "stripspace",
  "switch",
  "symbolic-ref",
  "tag",
  "update-index",
  "update-ref",
  "var",
  "verify-commit",
  "verify-tag",
  "version",
  "whatchanged",
  "worktree",
  "write-tree",
]);

export function gitRequiresNetwork(args: readonly string[]): boolean {
  const index = gitCommandIndex(args);
  if (index < 0) return false;
  const command = args[index]!;
  const rest = args.slice(index + 1);
  if (command === "archive")
    return rest.some((arg) => arg === "--remote" || arg.startsWith("--remote="));
  if (command === "remote") {
    const action = rest.find((arg) => !arg.startsWith("-"));
    if (action === undefined || ["get-url", "set-url", "rename", "remove", "rm"].includes(action))
      return false;
    if (action === "add") return rest.includes("-f") || rest.includes("--fetch");
    if (action === "show") return !rest.includes("-n");
    if (action === "set-head") return rest.includes("-a") || rest.includes("--auto");
    return true;
  }
  if (command === "submodule") {
    const action = rest.find((arg) => !arg.startsWith("-"));
    return (
      action !== undefined &&
      ![
        "status",
        "summary",
        "init",
        "deinit",
        "sync",
        "absorbgitdirs",
        "set-branch",
        "set-url",
      ].includes(action)
    );
  }
  // Unknown commands may be aliases or external helpers. They need the same grant as fetch/push.
  return !LOCAL_GIT_COMMANDS.has(command);
}

export function vcsRequiresNetwork(command: string, args: readonly string[]): boolean {
  const executable =
    command
      .replaceAll("\\", "/")
      .split("/")
      .at(-1)
      ?.replace(/\.(exe|cmd)$/i, "")
      .toLowerCase() ?? command;
  if (executable === "git") return gitRequiresNetwork(args);
  if (!["gh", "glab", "tea", "fj", "az"].includes(executable)) return false;
  return args.length !== 1 || !["--version", "version", "-v"].includes(args[0]!);
}
