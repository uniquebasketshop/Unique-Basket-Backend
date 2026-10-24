/**
 * Admin-safe view of a stored payment-gateway transaction (provider-neutral names).
 * The gateway's client secret and any signatures are never stored or returned.
 */
export interface StoredGatewayTransaction {
  id: string;
  provider: string;
  gatewayOrderId: string;
  gatewayPaymentId: string | null;
  paymentMethodDetail: string | null;
  failureReason: string | null;
  amount: unknown;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}

export const gatewayTransactionSelect = {
  id: true,
  provider: true,
  gatewayOrderId: true,
  gatewayPaymentId: true,
  paymentMethodDetail: true,
  failureReason: true,
  amount: true,
  status: true,
  createdAt: true,
  updatedAt: true,
} as const;

export function toGatewayTransaction(p: StoredGatewayTransaction) {
  return {
    id: p.id,
    provider: p.provider,
    gatewayOrderId: p.gatewayOrderId,
    gatewayPaymentId: p.gatewayPaymentId,
    paymentMethod: p.paymentMethodDetail,
    failureReason: p.failureReason,
    amount: p.amount,
    gatewayStatus: p.status,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

/** Admin-safe refund view. */
export const refundSelect = {
  id: true,
  gatewayRefundId: true,
  amount: true,
  status: true,
  reason: true,
  failureReason: true,
  createdAt: true,
  updatedAt: true,
} as const;
