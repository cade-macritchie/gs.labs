import { BrandHeader } from "@/components/BrandHeader";
import { EmbedResizeReporter } from "@/components/order/EmbedResizeReporter";
import { OrderFormClient } from "@/components/order/OrderFormClient";
import { groupByCategory, listProducts } from "@/lib/products";

// Reads the database on every request, so it must not be prerendered at build time.
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Merchandise Order Form — Gateway Seminary",
  description: "Browse Gateway Seminary merchandise and submit an order.",
};

export default async function OrderPage() {
  const products = await listProducts({ activeOnly: true });
  const groups = groupByCategory(products);

  return (
    <>
      <EmbedResizeReporter />
      <BrandHeader
        eyebrow="Merchandise"
        title="Order Form"
        subtitle="Choose your items and quantities, then send us your details. We'll follow up to confirm availability and totals before anything ships."
      />

      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-10">
        {products.length === 0 ? (
          <div className="rounded-brand border border-brand-darkgray/20 px-6 py-16 text-center">
            <p className="font-heading text-xl text-brand-black">The catalog is being updated</p>
            <p className="mt-2 font-body text-sm text-brand-darkgray/70">
              No items are available to order right now. Please check back soon.
            </p>
          </div>
        ) : (
          <OrderFormClient groups={groups} />
        )}
      </main>

      <footer className="border-t border-brand-darkgray/15 py-8">
        <p className="mx-auto max-w-6xl px-6 font-body text-xs text-brand-darkgray/60">
          Gateway Seminary · Questions about an order? Reply to the confirmation email you receive
          after submitting.
        </p>
      </footer>
    </>
  );
}
