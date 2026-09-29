"use client";

import { useMemo, useState } from "react";
import { ProductCard } from "@/components/order/ProductCard";
import { formatCents } from "@/lib/currency";
import { postToParent } from "@/lib/embed";
import type { Product } from "@/generated/prisma/client";

type Group = { category: string; products: Product[] };

const labelClass =
  "font-subheading text-[0.6875rem] font-semibold uppercase tracking-[0.14em] text-brand-darkgray";
const inputClass =
  "mt-2 w-full rounded-brand border border-brand-darkgray/25 bg-brand-white px-3 py-2 font-body text-sm text-brand-black outline-none focus:border-brand-teal";

export function OrderFormClient({ groups }: { groups: Group[] }) {
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [customerName, setCustomerName] = useState("");
  const [customerEmail, setCustomerEmail] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [organization, setOrganization] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [submittedId, setSubmittedId] = useState<string | null>(null);

  const allProducts = useMemo(() => groups.flatMap((group) => group.products), [groups]);

  const cart = useMemo(
    () =>
      allProducts
        .filter((product) => (quantities[product.id] ?? 0) > 0)
        .map((product) => ({ product, quantity: quantities[product.id] })),
    [allProducts, quantities],
  );

  const total = cart.reduce((sum, line) => sum + line.product.priceCents * line.quantity, 0);

  function setQuantity(productId: string, quantity: number) {
    setQuantities((previous) => {
      const next = { ...previous };
      if (quantity <= 0) {
        delete next[productId];
      } else {
        next[productId] = Math.min(quantity, 9999);
      }
      return next;
    });
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (cart.length === 0) {
      setError("Add at least one item before submitting.");
      return;
    }

    setPending(true);
    setError(null);

    const response = await fetch("/api/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        customerName,
        customerEmail,
        customerPhone,
        organization,
        notes,
        items: cart.map((line) => ({ productId: line.product.id, quantity: line.quantity })),
      }),
    });

    const data = await response.json().catch(() => ({}));

    if (response.ok) {
      setSubmittedId(data.orderId);
      // Inside the Slate iframe the portal page may be scrolled past the confirmation.
      postToParent({ type: "merch-order-scroll-top" });
      window.scrollTo({ top: 0 });
      return;
    }

    const fieldIssue = data.issues
      ? Object.values(data.issues as Record<string, string[]>)[0]?.[0]
      : null;
    setError(fieldIssue ?? data.error ?? "Something went wrong. Please try again.");
    setPending(false);
  }

  if (submittedId) {
    return (
      <div className="mx-auto max-w-xl rounded-brand border border-brand-darkgray/20 px-8 py-14 text-center">
        <p className="eyebrow justify-center text-brand-teal">Order received</p>
        <h2 className="mt-4 font-heading text-3xl text-brand-black">Thank you</h2>
        <div className="mx-auto mt-4 h-[3px] w-10 bg-brand-rust" />
        <p className="mt-6 font-body text-sm leading-relaxed text-brand-darkgray">
          We sent a confirmation to <strong>{customerEmail}</strong>. Our team will follow up to
          confirm availability and totals.
        </p>
        <p className="mt-6 font-body text-xs text-brand-darkgray/60">
          Order reference: {submittedId}
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="grid gap-10 lg:grid-cols-[1fr_20rem] lg:items-start">
      <div className="space-y-12">
        {groups.map((group) => (
          <section key={group.category}>
            <h2 className="rule-rust font-heading text-2xl text-brand-black">{group.category}</h2>
            <div className="mt-6 grid gap-4 sm:grid-cols-2">
              {group.products.map((product) => (
                <ProductCard
                  key={product.id}
                  product={product}
                  quantity={quantities[product.id] ?? 0}
                  onQuantityChange={(quantity) => setQuantity(product.id, quantity)}
                />
              ))}
            </div>
          </section>
        ))}
      </div>

      <aside className="lg:sticky lg:top-6">
        <div className="rounded-brand border border-brand-darkgray/20">
          <div className="bg-brand-black px-5 py-4">
            <p className="font-subheading text-[0.6875rem] font-semibold uppercase tracking-[0.18em] text-brand-gold">
              Your order
            </p>
          </div>

          <div className="px-5 py-5">
            {cart.length === 0 ? (
              <p className="font-body text-sm text-brand-darkgray/70">
                Nothing selected yet. Set a quantity on any item to begin.
              </p>
            ) : (
              <ul className="space-y-3">
                {cart.map((line) => (
                  <li key={line.product.id} className="flex items-baseline justify-between gap-3">
                    <span className="font-body text-sm text-brand-darkgray">
                      {line.product.name}
                      <span className="text-brand-grayblue"> × {line.quantity}</span>
                    </span>
                    <span className="font-body text-sm font-semibold text-brand-black">
                      {formatCents(line.product.priceCents * line.quantity)}
                    </span>
                  </li>
                ))}
              </ul>
            )}

            <div className="mt-5 flex items-baseline justify-between border-t border-brand-darkgray/15 pt-4">
              <span className="font-subheading text-[0.6875rem] font-semibold uppercase tracking-[0.14em] text-brand-darkgray">
                Estimated total
              </span>
              <span className="font-body text-lg font-semibold text-brand-black">
                {formatCents(total)}
              </span>
            </div>
          </div>

          <div className="space-y-4 border-t border-brand-darkgray/15 px-5 py-5">
            <label className="block">
              <span className={labelClass}>Your name</span>
              <input
                value={customerName}
                onChange={(event) => setCustomerName(event.target.value)}
                required
                maxLength={200}
                className={inputClass}
              />
            </label>

            <label className="block">
              <span className={labelClass}>Email</span>
              <input
                type="email"
                value={customerEmail}
                onChange={(event) => setCustomerEmail(event.target.value)}
                required
                maxLength={200}
                className={inputClass}
              />
            </label>

            <label className="block">
              <span className={labelClass}>Phone</span>
              <input
                type="tel"
                value={customerPhone}
                onChange={(event) => setCustomerPhone(event.target.value)}
                maxLength={50}
                className={inputClass}
              />
            </label>

            <label className="block">
              <span className={labelClass}>Church or organization</span>
              <input
                value={organization}
                onChange={(event) => setOrganization(event.target.value)}
                maxLength={200}
                className={inputClass}
              />
            </label>

            <label className="block">
              <span className={labelClass}>Notes</span>
              <textarea
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
                rows={3}
                maxLength={2000}
                placeholder="Sizes, delivery timing, anything else we should know"
                className={`${inputClass} resize-y`}
              />
            </label>

            {error ? (
              <p className="rounded-brand border border-brand-rust px-3 py-2 font-body text-sm text-brand-rust">
                {error}
              </p>
            ) : null}

            <button
              type="submit"
              disabled={pending}
              className="w-full rounded-brand bg-brand-gold px-4 py-3 font-subheading text-xs font-semibold uppercase tracking-[0.14em] text-brand-black transition-colors hover:bg-brand-black hover:text-brand-white disabled:opacity-60"
            >
              {pending ? "Submitting…" : "Submit order"}
            </button>

            <p className="font-body text-xs leading-relaxed text-brand-darkgray/60">
              Submitting sends your selections to our merchandise team. Nothing is charged now.
            </p>
          </div>
        </div>
      </aside>
    </form>
  );
}
