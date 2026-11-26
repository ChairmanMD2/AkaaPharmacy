/** Client-side password rules (the server-side minimum is set in Supabase Auth settings). */
export function passwordProblem(pw: string): string | null {
  if (pw.length < 10) return 'Use at least 10 characters.';
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return 'Include at least one letter and one number.';
  if (/^(.)\1+$/.test(pw)) return 'Choose a less repetitive password.';
  return null;
}
