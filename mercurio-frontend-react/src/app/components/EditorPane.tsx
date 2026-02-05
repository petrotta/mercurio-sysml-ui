import type { ReactNode } from "react";
import type { OpenTab } from "../types";
import { TabBar } from "./TabBar";

type EditorPaneProps = {
  openTabs: OpenTab[];
  activeTabPath: string | null;
  tabOverflowOpen: boolean;
  onSetTabOverflowOpen: (next: boolean | ((prev: boolean) => boolean)) => void;
  onSelectTab: (path: string) => void;
  onCloseTab: (path: string) => void;
  onReorderTabs: (fromPath: string, toPath: string) => void;
  onTabContextMenu: (path: string, x: number, y: number) => void;
  children: ReactNode;
};

export function EditorPane({
  openTabs,
  activeTabPath,
  tabOverflowOpen,
  onSetTabOverflowOpen,
  onSelectTab,
  onCloseTab,
  onReorderTabs,
  onTabContextMenu,
  children,
}: EditorPaneProps) {
  return (
    <section className="panel editor">
      <TabBar
        openTabs={openTabs}
        activeTabPath={activeTabPath}
        tabOverflowOpen={tabOverflowOpen}
        onSetTabOverflowOpen={onSetTabOverflowOpen}
        onSelectTab={onSelectTab}
        onCloseTab={onCloseTab}
        onReorderTabs={onReorderTabs}
        onTabContextMenu={onTabContextMenu}
      />
      <div className="editor-host" id="monaco-root">
        {children}
      </div>
    </section>
  );
}
