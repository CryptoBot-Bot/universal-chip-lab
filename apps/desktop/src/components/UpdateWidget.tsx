import { useEffect, useState } from "react";

import { Api, type UpdateState } from "../lib/api";
import { UpdateCenter } from "./UpdateCenter";

export function UpdateWidget() {
  const [version, setVersion] = useState("");
  const [state, setState] = useState<UpdateState | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    Api.updates.getState().then((s) => { setVersion(s.version); setState(s.last); }).catch(() => undefined);
    const off = Api.updates.onState((s) => setState(s));
    return off;
  }, []);

  return (
    <div className="tiny dim" style={{ marginTop: 10 }}>
      <div>Universal Chip Lab v{version || "?"}</div>
      {state?.state === "ready" ? (
        <button className="tiny primary" style={{ marginTop: 6, width: "100%" }} onClick={() => Api.updates.install()}>
          Install v{state?.version} &amp; restart
        </button>
      ) : (
        <button className="tiny" style={{ marginTop: 6, width: "100%" }} onClick={() => setOpen(true)}>
          {state?.state === "downloading" ? `Downloading ${state?.percent ?? 0}%…` : "Update Center"}
        </button>
      )}
      {open && <UpdateCenter onClose={() => setOpen(false)} />}
    </div>
  );
}
