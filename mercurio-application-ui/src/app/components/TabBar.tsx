import { useEffect, useRef, useState } from "react";
import { getTabIcon, getTabKindClass } from "../tabs";
import type { OpenTab } from "../types";

type TabBarProps = {
  openTabs: OpenTab[];
  activeTabPath: string | null;
  tabOverflowOpen: boolean;
  onSetTabOverflowOpen: (next: boolean | ((prev: boolean) => boolean)) => void;
  onSelectTab: (path: string) => void;
  onCloseTab: (path: string) => void;
  onReorderTabs: (fromPath: string, toPath: string) => void;
  onTabContextMenu: (path: string, x: number, y: number) => void;
};

export function TabBar(props: TabBarProps) {
  const draggedTabPathRef = useRef<string | null>(null);
  const tabsRef = useRef<HTMLDivElement | null>(null);
  const [hasOverflow, setHasOverflow] = useState(false);

  useEffect(() => {
    const el = tabsRef.current;
    if (!el) return;
    const update = () => {
      setHasOverflow(el.scrollWidth > el.clientWidth + 2);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [props.openTabs.length]);

  useEffect(() => {
    const container = tabsRef.current;
    if (!container || !props.activeTabPath) return;
    const active = container.querySelector<HTMLButtonElement>(".tab.active");
    if (!active) return;
    active.scrollIntoView({ block: "nearest", inline: "center" });
  }, [props.activeTabPath, props.openTabs.length]);

  return (
    <div className="panel-header editor-tabs">
      <div className="tabs" ref={tabsRef}>
        {props.openTabs.length ? (
          props.openTabs.map((tab) => (
            <button
              key={tab.path}
              type="button"
              className={`tab tab-kind-${getTabKindClass(tab)} ${tab.path === props.activeTabPath ? "active" : ""}`}
              draggable
              onClick={() => props.onSelectTab(tab.path)}
              onDragStart={() => {
                draggedTabPathRef.current = tab.path;
              }}
              onDragOver={(event) => {
                event.preventDefault();
              }}
              onDrop={(event) => {
                event.preventDefault();
                const fromPath = draggedTabPathRef.current;
                if (fromPath) {
                  props.onReorderTabs(fromPath, tab.path);
                }
              }}
              onDragEnd={() => {
                draggedTabPathRef.current = null;
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
                props.onTabContextMenu(tab.path, event.clientX, event.clientY);
              }}
            >
              <span className="tab-icon" aria-hidden="true">
                {getTabIcon(tab)}
              </span>
              <span className="tab-label">{tab.name}</span>
              {tab.dirty ? (
                <span className="tab-dirty" aria-hidden="true">
                  *
                </span>
              ) : null}
              <span
                className="tab-close"
                onClick={(event) => {
                  event.stopPropagation();
                  props.onCloseTab(tab.path);
                }}
              >
                x
              </span>
            </button>
          ))
        ) : (
          <div className="muted">No files open.</div>
        )}
      </div>
      {props.openTabs.length && hasOverflow ? (
        <div className="tab-overflow">
          <button
            type="button"
            className="tab-overflow-btn"
            title="Tab overflow"
            onClick={() => props.onSetTabOverflowOpen((prev) => !prev)}
          >
            v
          </button>
          {props.tabOverflowOpen ? (
            <div className="tab-overflow-menu">
              {props.openTabs.map((tab) => (
                <button
                  key={tab.path}
                  type="button"
                  className={tab.path === props.activeTabPath ? "active" : ""}
                  onClick={() => {
                    props.onSetTabOverflowOpen(false);
                    props.onSelectTab(tab.path);
                  }}
                >
                  {getTabIcon(tab)} {tab.name}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
