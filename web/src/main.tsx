import { createRoot } from "react-dom/client";
import "./style.css";

const match = location.pathname.match(/^\/display\/([a-z0-9-]+)$/);
const root = createRoot(document.getElementById("root")!);
const loaded = match
  ? import("./Display.js").then(({ Display }) =>
      root.render(<Display slug={match[1]} />),
    )
  : import("./App.js").then(({ App }) => root.render(<App />));
void loaded.catch(() =>
  root.render(
    <main className="display-message">
      <h1>This screen needs a refresh.</h1>
      <button onClick={() => location.reload()}>Try again</button>
    </main>,
  ),
);
