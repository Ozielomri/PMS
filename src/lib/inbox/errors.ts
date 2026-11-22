/** Turns database errors from the inbox RPCs into short, user-facing text. */
const MESSAGES: [pattern: RegExp, text: string][] = [
  [/^unresolved_variables|messages_no_unresolved_variables/, "Some variables have no value yet. Fill them in or remove them before sending."],
  [/^no_recipient/, "This conversation has no email address to reply to. Add one to the guest profile."],
  [/^channel_unavailable/, "That channel is not connected yet. Reply by email."],
  [/^conversation_not_found/, "Conversation not found."],
  [/^message_not_found/, "Message not found."],
  [/^delivery_transition_invalid/, "That message cannot be retried or discarded in its current state."],
  [/^not_a_member/, "Pick someone from your team."],
  [/^proposal_not_pending/, "This suggestion was already used or dismissed."],
  [/^ai_drafts_disabled/, "AI reply suggestions are switched off for this account."],
  [/^reservation_has_no_guest/, "Owner stays have no guest to message."],
  [/^empty_message/, "Write a message first."],
  [/^message_too_long/, "The message is too long for this channel."],
  [/messages_append_only|is append-only/, "Messages cannot be edited or deleted after sending."],
  [/^forbidden|permission denied|row-level security/, "You do not have permission to do that."],
  [/saved_replies_account_id_shortcut_key/, "Another saved reply already uses that shortcut."],
  [/^invalid_variants/, "Check the language variants."],
];

export function inboxErrorMessage(message: string | null | undefined): string {
  const m = message ?? "";
  for (const [pattern, text] of MESSAGES) if (pattern.test(m)) return text;
  return "Something went wrong. Try again.";
}
