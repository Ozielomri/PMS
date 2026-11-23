export const JOB_STATUS_LABEL: Record<string, string> = {
  scheduled: "Scheduled",
  running: "Running",
  sent: "Sent",
  failed: "Failed",
  skipped: "Skipped",
  canceled: "Canceled",
};

export const JOB_STATUS_TONE: Record<string, "neutral" | "green" | "amber" | "red"> = {
  scheduled: "amber",
  running: "amber",
  sent: "green",
  failed: "red",
  skipped: "neutral",
  canceled: "neutral",
};
