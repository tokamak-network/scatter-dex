import { redirect } from "next/navigation";

// `/protocol` itself has no content — the sub-nav decides what to
// show. Redirect to the first tab so an admin landing on the bare
// route doesn't see an empty layout.
export default function ProtocolIndex(): never {
  redirect("/protocol/relayer-registry");
}
