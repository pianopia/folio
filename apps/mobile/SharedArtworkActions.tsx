import React, { useState } from "react";
import {
  Alert,
  Pressable,
  Text,
  TextInput,
  View,
  StyleSheet,
} from "react-native";
import type { Artwork } from "@folio/shared";

export default function SharedArtworkActions({
  art,
  request,
  onBlocked,
}: {
  art: Artwork;
  request: (path: string, init?: RequestInit) => Promise<unknown>;
  onBlocked: (ownerId: string) => Promise<void>;
}) {
  const [reporting, setReporting] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(block: boolean) {
    setBusy(true);
    try {
      await request(
        block
          ? `/users/${encodeURIComponent(art.ownerId!)}/block`
          : `/artworks/${encodeURIComponent(art.id)}/reports`,
        {
          method: "POST",
          ...(block ? {} : { body: JSON.stringify({ reason: reason.trim() }) }),
        },
      );
      if (block) await onBlocked(art.ownerId!);
      else {
        setReporting(false);
        setReason("");
        Alert.alert(
          "通報を受け付けました",
          "内容を確認します。作品は自動では削除されません。",
        );
      }
    } catch (e) {
      Alert.alert("処理できませんでした", (e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <View style={s.panel}>
      {reporting && (
        <>
          <Text style={s.text}>通報理由（1000文字以内）</Text>
          <TextInput
            accessibilityLabel="通報理由"
            value={reason}
            onChangeText={setReason}
            maxLength={1000}
            multiline
            editable={!busy}
            style={s.input}
          />
          <Pressable
            accessibilityRole="button"
            disabled={busy || !reason.trim()}
            onPress={() =>
              Alert.alert("この作品を通報", "入力した理由で通報しますか？", [
                { text: "キャンセル", style: "cancel" },
                { text: "通報する", onPress: () => void submit(false) },
              ])
            }
          >
            <Text style={s.text}>通報を送信</Text>
          </Pressable>
        </>
      )}
      <View style={s.row}>
        <Pressable
          accessibilityRole="button"
          disabled={busy}
          onPress={() => setReporting(!reporting)}
        >
          <Text style={s.text}>{reporting ? "キャンセル" : "通報"}</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          disabled={busy}
          onPress={() =>
            Alert.alert(
              "このユーザーをブロック",
              "このユーザーの共有作品が非表示になります。設定から解除できます。",
              [
                { text: "キャンセル", style: "cancel" },
                {
                  text: "ブロック",
                  style: "destructive",
                  onPress: () => void submit(true),
                },
              ],
            )
          }
        >
          <Text style={s.text}>ブロック</Text>
        </Pressable>
      </View>
    </View>
  );
}
const s = StyleSheet.create({
  panel: {
    backgroundColor: "#161a17ee",
    borderRadius: 12,
    padding: 14,
    gap: 12,
  },
  row: { flexDirection: "row", justifyContent: "center", gap: 32 },
  text: { color: "#fff", fontSize: 14, paddingVertical: 6 },
  input: {
    color: "#fff",
    borderWidth: 1,
    borderColor: "#ffffff60",
    borderRadius: 6,
    padding: 10,
    maxHeight: 120,
  },
});
