import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_inbox/")({
  component: NothingSelected,
});

/** Desktop only: the detail pane before an item is picked. Phones show the list instead. */
function NothingSelected() {
  return (
    <div className="state placeholder">
      <p>Pick an item on the left to see its details and what you can do next.</p>
    </div>
  );
}
