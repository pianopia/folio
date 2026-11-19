import React, {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
} from "react";
import {
  FlatList,
  View,
  Text,
  Image,
  Pressable,
  SafeAreaView,
  StatusBar,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  type ImageSourcePropType,
  type LayoutChangeEvent,
  type ListRenderItemInfo,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";

type ArtworkPage = {
  id: string;
  title: string;
  source: ImageSourcePropType;
};

function ArtworkPager({
  pages,
  index,
  width,
  height,
  onNavigate,
}: {
  pages: ArtworkPage[];
  index: number;
  width: number;
  height: number;
  onNavigate: (index: number) => void;
}) {
  const list = useRef<FlatList<ArtworkPage>>(null);
  const [initialIndex] = useState(index);
  const pageIndex = useRef(index);
  const userScroll = useRef(false);
  const pageStyle = useMemo(() => ({ width, height }), [width, height]);
  const renderPage = useCallback(
    ({ item }: ListRenderItemInfo<ArtworkPage>) => (
      <Image
        source={item.source}
        accessibilityLabel={item.title}
        resizeMode="contain"
        style={pageStyle}
      />
    ),
    [pageStyle],
  );

  useLayoutEffect(() => {
    if (pageIndex.current === index) return;
    userScroll.current = false;
    pageIndex.current = index;
    list.current?.scrollToIndex({ index, animated: false });
  }, [index]);

  function settlePage(offset: number) {
    // Programmatic jumps can also emit a momentum-end event on iOS.
    if (!userScroll.current) return;
    userScroll.current = false;
    const next = Math.max(
      0,
      Math.min(pages.length - 1, Math.round(offset / width)),
    );
    if (next === pageIndex.current) return;
    pageIndex.current = next;
    onNavigate(next);
  }

  function onScrollEndDrag({
    nativeEvent: { contentOffset, targetContentOffset },
  }: NativeSyntheticEvent<NativeScrollEvent>) {
    // A drag that stops on a page without coasting can finish here on iOS.
    const pageOffset = Math.round(contentOffset.x / width) * width;
    if (
      targetContentOffset &&
      Math.abs(targetContentOffset.x - pageOffset) < 0.5 &&
      Math.abs(contentOffset.x - pageOffset) < 0.5
    ) {
      settlePage(contentOffset.x);
    }
  }

  return (
    <FlatList
      ref={list}
      data={pages}
      horizontal
      pagingEnabled
      directionalLockEnabled
      pinchGestureEnabled={false}
      bounces={false}
      overScrollMode="never"
      showsHorizontalScrollIndicator={false}
      automaticallyAdjustContentInsets={false}
      style={StyleSheet.absoluteFillObject}
      keyExtractor={(page) => page.id}
      initialScrollIndex={initialIndex}
      initialNumToRender={3}
      windowSize={5}
      getItemLayout={(_, i) => ({ length: width, offset: width * i, index: i })}
      renderItem={renderPage}
      onScrollBeginDrag={() => {
        userScroll.current = true;
      }}
      onScrollEndDrag={onScrollEndDrag}
      onMomentumScrollEnd={({ nativeEvent }) =>
        settlePage(nativeEvent.contentOffset.x)
      }
    />
  );
}

export default function ArtworkViewer({
  artwork,
  pages,
  index,
  onNavigate,
  onClose,
  onCopy,
  copying,
  feedback,
  actions,
  children,
}: {
  artwork: ArtworkPage;
  pages: ArtworkPage[];
  index: number;
  onNavigate: (index: number) => void;
  onClose: () => void;
  onCopy: () => void;
  copying: boolean;
  feedback?: string;
  actions?: ComponentProps<typeof View>["children"];
  children: ComponentProps<typeof SafeAreaView>["children"];
}) {
  const [infoFor, setInfoFor] = useState<string | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const showInfo = infoFor === artwork.id;
  const count = pages.length;
  const canNavigate = index >= 0 && count > 1;

  function onLayout({
    nativeEvent: { layout: { width, height } },
  }: LayoutChangeEvent) {
    setSize((current) =>
      current.width === width && current.height === height
        ? current
        : { width, height },
    );
  }

  function navigate(next: number) {
    setInfoFor(null);
    onNavigate(next);
  }

  return (
    <View style={s.viewer} onLayout={onLayout}>
      <StatusBar barStyle="light-content" />
      {canNavigate && size.width > 0 && size.height > 0 ? (
        <ArtworkPager
          key={size.width}
          pages={pages}
          index={index}
          width={size.width}
          height={size.height}
          onNavigate={navigate}
        />
      ) : (
        <Image
          key={artwork.id}
          source={artwork.source}
          accessibilityLabel={artwork.title}
          resizeMode="contain"
          style={StyleSheet.absoluteFillObject}
        />
      )}
      <SafeAreaView style={s.controls} pointerEvents="box-none">
        <View style={s.topbar} pointerEvents="box-none">
          <Text style={s.counter}>
            {index + 1} / {count}
          </Text>
          <View style={s.tools} pointerEvents="box-none">
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="作品の詳細情報"
              accessibilityState={{ expanded: showInfo }}
              onPress={() => setInfoFor(showInfo ? null : artwork.id)}
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
        disabled={!canNavigate}
        onPress={() => navigate((index - 1 + count) % count)}
        style={[s.arrow, s.previous, !canNavigate && s.disabled]}
      >
        <Text style={s.arrowText}>‹</Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="次の作品"
        disabled={!canNavigate}
        onPress={() => navigate((index + 1) % count)}
        style={[s.arrow, s.next, !canNavigate && s.disabled]}
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
      {actions && (
        <KeyboardAvoidingView
          style={s.sharedActions}
          behavior={Platform.OS === "ios" ? "padding" : "height"}
          pointerEvents="box-none"
        >
          {actions}
        </KeyboardAvoidingView>
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
  sharedActions: {
    position: "absolute",
    bottom: 36,
    left: 20,
    right: 20,
    zIndex: 4,
  },
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
