import React, { useState, type ComponentProps } from "react";
import {
  View,
  Text,
  Image,
  Pressable,
  SafeAreaView,
  StatusBar,
  StyleSheet,
  type ImageSourcePropType,
} from "react-native";
export default function ArtworkViewer({
  id,
  title,
  source,
  index,
  count,
  onNavigate,
  onClose,
  onCopy,
  copying,
  feedback,
  children,
}: {
  id: string;
  title: string;
  source: ImageSourcePropType;
  index: number;
  count: number;
  onNavigate: (direction: number) => void;
  onClose: () => void;
  onCopy: () => void;
  copying: boolean;
  feedback?: string;
  children: ComponentProps<typeof SafeAreaView>["children"];
}) {
  const [infoFor, setInfoFor] = useState<string | null>(null);
  const showInfo = infoFor === id;
  function navigate(direction: number) {
    if (count < 2) return;
    setInfoFor(null);
    onNavigate(direction);
  }
  return (
    <View style={s.viewer}>
      <StatusBar barStyle="light-content" />
      <Image
        key={id}
        source={source}
        accessibilityLabel={title}
        resizeMode="contain"
        style={StyleSheet.absoluteFillObject}
      />
      <SafeAreaView style={s.controls} pointerEvents="box-none">
        <View style={s.topbar} pointerEvents="box-none">
          <Text style={s.counter}>
            {index + 1} / {count}
          </Text>
          <View style={s.tools}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="作品の詳細情報"
              accessibilityState={{ expanded: showInfo }}
              onPress={() => setInfoFor(showInfo ? null : id)}
              style={[s.icon, showInfo && s.active]}
            >
              <Text style={s.iconText}>ⓘ</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="画像をコピー"
              disabled={copying}
              onPress={onCopy}
              style={s.icon}
            >
              <Text style={s.iconText}>{copying ? "…" : "⧉"}</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="閉じる"
              onPress={onClose}
              style={s.icon}
            >
              <Text style={s.iconText}>×</Text>
            </Pressable>
          </View>
        </View>
      </SafeAreaView>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="前の作品"
        disabled={count < 2}
        onPress={() => navigate(-1)}
        style={[s.arrow, s.previous, count < 2 && s.disabled]}
      >
        <Text style={s.arrowText}>‹</Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="次の作品"
        disabled={count < 2}
        onPress={() => navigate(1)}
        style={[s.arrow, s.next, count < 2 && s.disabled]}
      >
        <Text style={s.arrowText}>›</Text>
      </Pressable>
      {showInfo && (
        <SafeAreaView style={s.info}>
          <View style={s.infoHeading}>
            <Text style={s.infoTitle}>作品の詳細</Text>
            <Pressable
              accessibilityLabel="詳細情報を閉じる"
              onPress={() => setInfoFor(null)}
              hitSlop={12}
            >
              <Text style={s.iconText}>×</Text>
            </Pressable>
          </View>
          {children}
        </SafeAreaView>
      )}
      {!!feedback && (
        <View style={s.feedback} pointerEvents="none">
          <Text accessibilityRole="alert" style={s.feedbackText}>
            {feedback}
          </Text>
        </View>
      )}
    </View>
  );
}
const s = StyleSheet.create({
  viewer: { flex: 1, backgroundColor: "#090a0b" },
  controls: { position: "absolute", top: 0, left: 0, right: 0, zIndex: 4 },
  topbar: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 14,
    paddingTop: 14,
  },
  counter: {
    color: "#eee",
    backgroundColor: "#0009",
    paddingHorizontal: 13,
    paddingVertical: 9,
    borderRadius: 24,
    fontSize: 12,
    fontVariant: ["tabular-nums"],
  },
  tools: { flexDirection: "row", gap: 8 },
  icon: {
    width: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: "#ffffff30",
    backgroundColor: "#0009",
    alignItems: "center",
    justifyContent: "center",
  },
  active: { backgroundColor: "#ffffff35", borderColor: "#fff9" },
  iconText: { color: "#fff", fontSize: 25 },
  arrow: {
    position: "absolute",
    top: "47%",
    width: 40,
    height: 60,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#ffffff30",
    backgroundColor: "#0009",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 3,
  },
  previous: { left: 8 },
  next: { right: 8 },
  arrowText: { color: "#fff", fontSize: 42, lineHeight: 48 },
  disabled: { opacity: 0.3 },
  info: {
    position: "absolute",
    top: 90,
    bottom: 26,
    left: 56,
    right: 56,
    zIndex: 3,
    borderRadius: 14,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: "#ffffff30",
    backgroundColor: "#000c",
  },
  infoHeading: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 4,
  },
  infoTitle: { color: "#fff", fontSize: 15, fontWeight: "600" },
  feedback: {
    position: "absolute",
    bottom: 26,
    left: 30,
    right: 30,
    padding: 12,
    borderRadius: 12,
    backgroundColor: "#000c",
    zIndex: 5,
  },
  feedbackText: { color: "#fff", fontSize: 12, textAlign: "center" },
});
