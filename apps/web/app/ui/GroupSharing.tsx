import { useEffect, useState } from "react";
import type { Group } from "@folio/shared";
import { request } from "./api";
type Member = { id: string; email: string; name: string };
export default function GroupSharing({
  groups,
  userId,
  onChanged,
}: {
  groups: Group[];
  userId: string;
  onChanged: () => Promise<void>;
}) {
  const owned = groups.filter((g) => g.ownerId === userId);
  const [selectedGroupId, setGroupId] = useState("");
  const groupId =
    owned.find((g) => g.id === selectedGroupId)?.id ?? owned[0]?.id ?? "";
  const [members, setMembers] = useState<Member[]>([]);
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [blocks, setBlocks] = useState<Member[]>([]);
  useEffect(() => {
    let current = true;
    request<{ users: Member[] }>("/blocks")
      .then((r) => {
        if (current) setBlocks(r.users);
      })
      .catch((e) => {
        if (current) setError(e.message);
      });
    return () => {
      current = false;
    };
  }, [userId]);
  useEffect(() => {
    let current = true;
    setMembers([]);
    setError("");
    if (groupId)
      request<{ members: Member[] }>(`/groups/${groupId}/members`)
        .then((r) => {
          if (current) setMembers(r.members);
        })
        .catch((e) => {
          if (current) setError(e.message);
        });
    return () => {
      current = false;
    };
  }, [groupId]);
  async function reload() {
    setMembers(
      (await request<{ members: Member[] }>(`/groups/${groupId}/members`))
        .members,
    );
  }
  return (
    <section className="sharing-settings">
      <h3>グループの共有</h3>
      {!!owned.length && (
        <>
          <p className="field-note">
            最初は自分だけが閲覧できます。追加したメンバーは、このグループの作品を表示・コピーできます。あなたのDrive全体にはアクセスできません。
          </p>
          <label>
            共有するグループ
            <select
              value={groupId}
              onChange={(e) => setGroupId(e.target.value)}
            >
              {owned.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
          </label>
          <ul>
            {members.map((m) => (
              <li key={m.id}>
                {m.email}{" "}
                <button
                  className="text-button"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    setError("");
                    try {
                      await request(`/groups/${groupId}/members/${m.id}`, {
                        method: "DELETE",
                      });
                      await reload();
                    } catch (e) {
                      setError((e as Error).message);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  共有を解除
                </button>
              </li>
            ))}
          </ul>
          {!members.length && (
            <p className="field-note">共有メンバーはいません。</p>
          )}
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setError("");
              try {
                await request(`/groups/${groupId}/members`, {
                  method: "POST",
                  body: JSON.stringify({ email }),
                });
                setEmail("");
                await reload();
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <label>
              メンバーのメールアドレス
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="name@example.com"
              />
            </label>
            <p className="field-note">
              相手に先にFolioへログインしてもらってください。このグループに今後追加する作品も共有されます。
            </p>
            <button className="button secondary full" disabled={busy}>
              このグループの閲覧を許可
            </button>
          </form>
        </>
      )}
      {groups
        .filter((g) => g.ownerId !== userId)
        .map((g) => (
          <p key={g.id}>
            {g.name}{" "}
            <button
              type="button"
              className="text-button"
              disabled={busy}
              onClick={async () => {
                if (
                  !window.confirm(
                    "このグループを退出しますか？共有作品が閲覧できなくなります。",
                  )
                )
                  return;
                setBusy(true);
                setError("");
                try {
                  await request(
                    `/groups/${encodeURIComponent(g.id)}/membership`,
                    { method: "DELETE" },
                  );
                  await onChanged();
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              グループを退出
            </button>
          </p>
        ))}
      <h3>ブロックしたユーザー</h3>
      {!blocks.length && (
        <p className="field-note">ブロックしたユーザーはいません。</p>
      )}
      {blocks.map((u) => (
        <p key={u.id}>
          {u.email || u.name}{" "}
          <button
            type="button"
            className="text-button"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError("");
              try {
                await request(`/users/${encodeURIComponent(u.id)}/block`, {
                  method: "DELETE",
                });
                setBlocks((items) => items.filter((item) => item.id !== u.id));
                await onChanged();
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            ブロックを解除
          </button>
        </p>
      ))}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
