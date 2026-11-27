import { supabase } from './supabase';

/**
 * Paystack is handled entirely by server functions (the secret key never reaches the browser):
 *  paystack-init   starts a payment and returns the Paystack page to open
 *  paystack-verify asks Paystack directly whether it was paid (the only thing we trust)
 * A sale/order may only count a Paystack payment that the server has confirmed AND not used before.
 */
async function call<T>(name: string, body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke(name, { body });
  if (error) {
    let msg = error.message;
    try { const j = await (error as any).context?.json?.(); if (j?.error) msg = j.error; } catch { /* keep generic */ }
    throw new Error(msg);
  }
  if ((data as any)?.error) throw new Error((data as any).error);
  return data as T;
}

export const paystackConfigured = async () => (await call<{ configured: boolean }>('paystack-init', { action: 'status' })).configured;

export const initPaystack = (p: { amount: number; email?: string; purpose: 'pos' | 'order'; order_id?: string }) =>
  call<{ reference: string; authorization_url: string }>('paystack-init', { action: 'init', ...p, callback_url: `${window.location.origin}/paystack-return` });

export type PaystackStatus = 'success' | 'pending' | 'failed';
export const verifyPaystack = (reference: string) => call<{ status: PaystackStatus; message?: string }>('paystack-verify', { reference });
