/** Signing in, resetting a password, and the pages that email links open. */
export const auth = {
  signInTitle: 'Sign in',
  email: 'Email',
  password: 'Password',
  signIn: 'Sign in',
  forgot: 'Forgot your password?',

  // Waiting for the session check on any page that needs one
  checkingSession: 'Checking your sign-in…',

  // Asking for a reset link
  resetTitle: 'Reset your password',
  resetIntro: "Enter your email and we'll send you a link to choose a new one.",
  sendLink: 'Send me a link',
  resetSent: 'If that email has an account, we sent a link.',
  backToSignIn: 'Back to sign in',

  // Choosing a new password from the link
  newPasswordTitle: 'Choose a new password',
  newPassword: 'New password',
  passwordHelp: 'Use at least 10 characters.',
  savePassword: 'Save password',
  passwordChanged: 'Your password is changed. You can sign in now.',
  askNewLink: 'Ask for a new link',

  // Confirming an email address from the link
  verifyTitle: 'Confirm your email',
  verifying: 'Confirming your email…',
  emailConfirmed: 'Your email is confirmed.',
  continue: 'Continue',

  // A link with its token cut off
  linkIncomplete: 'That link is incomplete. Please open it again from your email.',

  // Joining a team from an invite
  inviteTitle: 'Join your team',
  inviteIntro: 'Choose your name and a password to join.',
  name: 'Your name',
  acceptInvite: 'Join the team',
  signInToJoin: 'Sign in to join',
} as const;
