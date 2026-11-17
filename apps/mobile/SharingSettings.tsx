import React, { useEffect, useState } from "react";
import {
  Alert,
  Pressable,
  Text,
  TextInput,
  View,
  StyleSheet,
} from "react-native";
import type { Group } from "@folio/shared";

type Member = { id: string; email: string; name: string };
export default function SharingSettings({
  groups,
  userId,
  request,
  onChanged,
}: {
  groups: Group[];
  userId: string;
  request: <T>(path: string, init?: RequestInit) => Promise<T>;
  onChanged: () => Promise<void>;
}) {
  const [groupId, setGroupId] = useState("");
  const [members, setMembers] = useState<Member[]>([]);
  const [blocks, setBlocks] = useState<Member[]>([]);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const selected = groups.find((g) => g.id === groupId);
  const owner = selected?.ownerId === userId;
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
  }, [userId, request]);
  useEffect(() => {
    let current = true;
    setMembers([]);
    setError("");
    setEmail("");
    if (owner)
      request<{ members: Member[] }>(
        `/groups/${encodeURIComponent(groupId)}/members`,
      )
        .then((r) => {
          if (current) setMembers(r.members);
        })
        .catch((e) => {
          if (current) setError(e.message);
        });
    return () => {
      current = false;
    };
  }, [groupId, owner, request]);
  async function mutate(path: string, method: string, body?: unknown) {
    setBusy(true);
    setError("");
    try {
      await request(path, {
        method,
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (owner)
        setMembers(
          (
            await request<{ members: Member[] }>(
              `/groups/${encodeURIComponent(groupId)}/members`,
            )
          ).members,
        );
      setBlocks((await request<{ users: Member[] }>("/blocks")).users);
      setEmail("");
      await onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <View style={s.section}>
      <Text style={s.heading}>グループの共有</Text>
      <Text style={s.help}>
        オーナーは、Folioにログイン済みの相手を追加できます。メンバーは、このグループの作品を閲覧・コピーできます。
      </Text>
      {groups.map((g) => (
        <Pressable
          key={g.id}
          disabled={busy}
          onPress={() => setGroupId(g.id)}
          style={[s.button, groupId === g.id && s.active]}
        >
          <Text style={s.text}>
            {g.name} · {g.ownerId === userId ? "オーナー" : "メンバー"}
          </Text>
        </Pressable>
      ))}
      {selected &&
        (owner ? (
          <>
            <Text style={s.help}>共有メンバー</Text>
            {!members.length && (
              <Text style={s.help}>共有メンバーはいません。</Text>
            )}
            {members.map((m) => (
              <View key={m.id} style={s.member}>
                <Text style={s.text}>{m.email || m.name}</Text>
                <Pressable
                  disabled={busy}
                  onPress={() =>
                    Alert.alert(
                      "共有を解除",
                      `${m.email || m.name} の閲覧権限を解除しますか？`,
                      [
                        { text: "キャンセル", style: "cancel" },
                        {
                          text: "解除する",
                          onPress: () =>
                            void mutate(
                              `/groups/${encodeURIComponent(
                                groupId,
                              )}/members/${encodeURIComponent(m.id)}`,
                              "DELETE",
                            ),
                        },
                      ],
                    )
                  }
                >
                  <Text style={s.link}>共有を解除</Text>
                </Pressable>
              </View>
            ))}
            <TextInput
              accessibilityLabel="メンバーのメールアドレス"
              placeholder="メールアドレス"
              keyboardType="email-address"
              autoCapitalize="none"
              value={email}
              onChangeText={setEmail}
              style={s.input}
              editable={!busy}
            />
            <Pressable
              disabled={busy || !email.trim()}
              style={s.button}
              onPress={() =>
                void mutate(
                  `/groups/${encodeURIComponent(groupId)}/members`,
                  "POST",
                  { email },
                )
              }
            >
              <Text style={s.link}>メンバーを追加</Text>
            </Pressable>
          </>
        ) : (
          <Pressable
            disabled={busy}
            style={s.button}
            onPress={() =>
              Alert.alert(
                "グループを退出",
                "このグループの共有作品が閲覧できなくなります。",
                [
                  { text: "キャンセル", style: "cancel" },
                  {
                    text: "退出する",
                    style: "destructive",
                    onPress: () =>
                      void mutate(
                        `/groups/${encodeURIComponent(groupId)}/membership`,
                        "DELETE",
                      ),
                  },
                ],
              )
            }
          >
            <Text style={s.link}>グループを退出</Text>
          </Pressable>
        ))}
      <Text style={s.heading}>ブロックしたユーザー</Text>
      {!blocks.length && (
        <Text style={s.help}>ブロックしたユーザーはいません。</Text>
      )}
      {blocks.map((u) => (
        <View key={u.id} style={s.member}>
          <Text style={s.text}>{u.email || u.name}</Text>
          <Pressable
            disabled={busy}
            onPress={() =>
              void mutate(`/users/${encodeURIComponent(u.id)}/block`, "DELETE")
            }
          >
            <Text style={s.link}>ブロックを解除</Text>
          </Pressable>
        </View>
      ))}
      {!!error && (
        <Text accessibilityRole="alert" style={s.error}>
          {error}
        </Text>
      )}
    </View>
  );
}
const s = StyleSheet.create({
  section: { gap: 10, marginVertical: 20 },
  heading: { fontSize: 17, fontWeight: "600", color: "#303c2b", marginTop: 10 },
  help: { fontSize: 12, lineHeight: 20, color: "#6f7c65" },
  text: { fontSize: 14, color: "#303c2b" },
  link: { fontSize: 14, color: "#526945", paddingVertical: 8 },
  button: { padding: 12, borderRadius: 8, backgroundColor: "#f0f3eb" },
  active: { backgroundColor: "#dfe9d5" },
  member: {
    gap: 2,
    borderBottomWidth: 1,
    borderColor: "#e0e6da",
    paddingVertical: 6,
  },
  input: {
    borderWidth: 1,
    borderColor: "#d4deca",
    borderRadius: 8,
    padding: 12,
    color: "#303c2b",
  },
  error: { color: "#9c4a3a", fontSize: 13 },
});
