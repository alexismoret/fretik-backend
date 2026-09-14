import type { ToolApprovalSummaryField } from "@fretik/shared/db/schema";
import {
  arr,
  asString,
  bool,
  prop,
  str,
  strArray,
} from "@fretik/shared/external-apps/json-access";
import type {
  OperationSummaryPart,
  ProviderSummaries,
  SummaryMapper,
} from "@fretik/shared/external-apps/provider-types";

/**
 * Approval-card summaries for the five write actions.
 *
 * What a reader of one of these cards can verify is the PATHS: a person who
 * knows their own file server reads `/edi/out/ORDER_2026-09.csv` and knows
 * instantly whether that is the right place. So every card leads with paths
 * and a count, and none of them shows a byte count or a base64 blob, which
 * verify nothing.
 *
 * The two destructive actions get separate treatment on purpose.
 * `delete_directory` with `recursive: true` is the one operation here with
 * no undo on any of the three protocols, so its title says so instead of
 * reading like the ordinary folder delete it otherwise resembles.
 */

const field = (labelKey: string, value: string): ToolApprovalSummaryField => ({
  labelKey,
  value,
});

const compact = (
  ...fields: (ToolApprovalSummaryField | null)[]
): ToolApprovalSummaryField[] =>
  fields.filter((f): f is ToolApprovalSummaryField => f !== null);

/**
 * Render up to the first 8 paths with a "+N more" tail.
 *
 * Eight rather than the five used for message IDs elsewhere: a path is
 * readable, an opaque ID is not, so showing more of them actually helps the
 * reviewer instead of padding the card.
 */
const pathsPreview = (paths: string[]): string => {
  if (paths.length === 0) return "";
  const head = paths.slice(0, 8).join("\n");
  return paths.length > 8
    ? `${head}\n…(+${(paths.length - 8).toString()})`
    : head;
};

const uploadFiles: SummaryMapper = (args): OperationSummaryPart => {
  const paths = arr(args.files).map((file) => str(prop(file, "remote_path")));
  const onConflict = str(args.on_conflict, "replace");
  return {
    titleKey: paths.length === 1 ? "single" : "default",
    titleParams: {
      count: paths.length.toString(),
      path: paths[0] ?? "",
    },
    fields: compact(
      field("count", paths.length.toString()),
      field("paths", pathsPreview(paths)),
      // The one upload setting with a consequence a reviewer should see:
      // `replace` overwrites a file that is already there.
      field("on_conflict", onConflict),
    ),
  };
};

const moveEntries: SummaryMapper = (args) => {
  const moves = arr(args.moves);
  const rendered = moves.map(
    (move) => `${str(prop(move, "from_path"))} → ${str(prop(move, "to_path"))}`,
  );
  return {
    titleKey: moves.length === 1 ? "single" : "default",
    titleParams: { count: moves.length.toString(), move: rendered[0] ?? "" },
    fields: compact(
      field("count", moves.length.toString()),
      field("moves", pathsPreview(rendered)),
    ),
  };
};

const deleteFiles: SummaryMapper = (args) => {
  const paths = strArray(args.paths);
  return {
    titleKey: paths.length === 1 ? "single" : "default",
    titleParams: { count: paths.length.toString(), path: paths[0] ?? "" },
    fields: compact(
      field("count", paths.length.toString()),
      field("paths", pathsPreview(paths)),
    ),
  };
};

const createDirectory: SummaryMapper = (args) => {
  const mode = asString(args.mode);
  return {
    titleKey: "default",
    titleParams: { path: str(args.path) },
    fields: compact(
      field("path", str(args.path)),
      mode !== undefined ? field("mode", mode) : null,
    ),
  };
};

const deleteDirectory: SummaryMapper = (args) => ({
  // A recursive folder delete is unrecoverable on all three protocols —
  // there is no recycle bin anywhere in FTP or SFTP. The card has to say
  // that in its title, where it cannot be skimmed past.
  titleKey: bool(args.recursive, false) ? "recursive" : "default",
  titleParams: { path: str(args.path) },
  fields: [field("path", str(args.path))],
});

export const ftpSftpSummaries: ProviderSummaries = {
  upload_files: uploadFiles,
  move_entries: moveEntries,
  delete_files: deleteFiles,
  create_directory: createDirectory,
  delete_directory: deleteDirectory,
};
