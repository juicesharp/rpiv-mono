export const FLAG_DEBUG = "rpiv-debug";
export const MSG_TYPE_GIT_CONTEXT = "rpiv-git-context";
export const MSG_TYPE_GUIDANCE = "rpiv-guidance";
export const MSG_TYPE_PIPELINE_INDEX = "rpiv-pipeline-index";
/** Timeout for git exec calls (milliseconds). */
export const GIT_EXEC_TIMEOUT_MS = 5000;
/** Grace period before SIGKILL when terminating a timed-out pi install process. */
export const SIGKILL_GRACE_MS = 5000;
/** Exit code returned when pi install times out. */
export const EXIT_TIMEOUT = 124;
