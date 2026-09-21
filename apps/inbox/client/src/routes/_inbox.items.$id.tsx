import { createFileRoute } from "@tanstack/react-router";
import { ItemDetailView } from "../components/Detail";
import { useBusiness, useSettings } from "../lib/queries";

export const Route = createFileRoute("/_inbox/items/$id")({
  component: ItemPage,
});

function ItemPage() {
  const { id } = Route.useParams();
  const settings = useSettings();
  const business = useBusiness();
  const tz = business.data?.timezone ?? settings.data?.doc.business.timezone;
  const name = business.data?.name || settings.data?.doc.business.name || undefined;
  const currency = business.data?.currency ?? settings.data?.doc.business.currency;
  return <ItemDetailView key={id} id={id} tz={tz} business={name} currency={currency} />;
}
