export const SUBMISSION_RECOVERY_MESSAGES = Object.freeze({
  unconfirmed: 'Acceptance of this submission is unconfirmed. Its identifier was saved. Open Runs & Results and check the receipt before submitting work again.',
  earlier: 'An earlier submission has not been confirmed. Open Runs & Results and check its receipt before starting more work.',
  storage: 'The submission identifier could not be saved on this computer. No work was submitted. Free browser storage and try again.',
  identity: 'The authenticated server identity could not be confirmed. Sign in again before submitting work.',
  limit: 'The saved submission limit has been reached. Resolve earlier submissions in Runs & Results before starting more work.',
  invalid: 'A valid submission identity is required. No work was submitted.',
  coordination: 'This browser cannot safely coordinate saved submissions across windows. Use a current browser or the desktop app before submitting work.',
});
