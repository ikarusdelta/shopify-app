import { redirect } from "react-router";

export const loader = async ({ request }) => {
  const url = new URL(request.url);
  return redirect('/app?' + url.searchParams.toString());
};

export default function Home() {
  return null;
}