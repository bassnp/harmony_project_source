import { redirect } from "next/navigation";

/**
 * Root page — redirects to /new (New Title workspace).
 */
export default function Home() {
  redirect("/new");
}
