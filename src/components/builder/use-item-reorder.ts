"use client";

import { useRef, useState } from "react";

/**
 * One state machine for all three ways of reordering the item list.
 *
 * Before this there were two, side by side in items-list.tsx -- the native
 * HTML5 drag for a mouse, and a pointer-event path for touch, because mobile
 * browsers never start an HTML5 drag -- and no keyboard path at all. What
 * stood in for one was a pair of up/down buttons hidden below 768px, so on a
 * phone a keyboard user could not reorder anything.
 *
 * The keyboard path lives in the same machine rather than beside it: Space
 * or Enter picks an item up, the arrows move it, Space, Enter or Tab drops
 * it, Escape puts it back where it started.
 *
 * Escape really does put it back. Each arrow press commits, because a move
 * held only in local state would be reverted by the next server render the
 * moment anything else on the page saved; so cancelling means committing the
 * order remembered at pick-up, not discarding an uncommitted draft.
 */

export function arrayMove<T>(list: T[], from: number, to: number): T[] {
  const copy = list.slice();
  const [moved] = copy.splice(from, 1);
  copy.splice(to, 0, moved);
  return copy;
}

type Item = { id: string; name: string };

export function useItemReorder<T extends Item>({
  items,
  commitOrder,
}: {
  /** The list as it is on screen right now -- the optimistic one, so a move
   * made while the previous one is still in flight starts from what the user
   * can see rather than from the server's last word. */
  items: T[];
  commitOrder: (next: T[]) => void;
}) {
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  /** The item the keyboard is currently carrying, or null. */
  const [grabbedId, setGrabbedId] = useState<string | null>(null);
  /** What the `aria-live` region says. Every move writes one, because a
   * reorder is invisible to a screen reader otherwise: focus stays on the
   * same button and the button's own label never changes. */
  const [announcement, setAnnouncement] = useState("");

  const cardNodes = useRef(new Map<string, HTMLElement>());
  /** The in-flight touch/pen drag, or null. Mouse drags do not come through
   * here at all -- they use the native HTML5 drag, which gives a real drag
   * image for free. */
  const pointerDrag = useRef<{ pointerId: number; itemId: string } | null>(null);
  /** The order at the moment the keyboard picked an item up, so Escape has
   * something to restore. */
  const orderBeforeGrab = useRef<T[] | null>(null);

  function announceAt(item: T, index: number, prefix = "", suffix = "") {
    setAnnouncement(`${prefix}${item.name}, position ${index + 1} of ${items.length}.${suffix}`);
  }

  function moveBy(index: number, delta: number) {
    const targetIndex = index + delta;
    if (targetIndex < 0 || targetIndex >= items.length) return;
    const next = arrayMove(items, index, targetIndex);
    commitOrder(next);
    const item = items[index]!;
    announceAt(item, targetIndex);
  }

  /** The id of the item card under a viewport point, or null when the point
   * is outside every card. Hit-testing the DOM is what stands in for
   * `dragover`/`drop` during a pointer drag: those fire only for the native
   * HTML5 drag, which touch browsers never start. */
  function itemIdAtPoint(clientX: number, clientY: number): string | null {
    const card = document
      .elementFromPoint(clientX, clientY)
      ?.closest<HTMLElement>("[data-builder-item-id]");
    return card?.dataset.builderItemId ?? null;
  }

  function dropOn(targetId: string) {
    setDropTargetId(null);
    const sourceId = draggingId;
    setDraggingId(null);
    if (!sourceId || sourceId === targetId) return;
    const fromIndex = items.findIndex((item) => item.id === sourceId);
    const toIndex = items.findIndex((item) => item.id === targetId);
    if (fromIndex === -1 || toIndex === -1) return;
    commitOrder(arrayMove(items, fromIndex, toIndex));
    announceAt(items[fromIndex]!, toIndex);
  }

  function endPointerDrag(clientX: number, clientY: number) {
    const drag = pointerDrag.current;
    if (!drag) return;
    pointerDrag.current = null;
    const targetId = itemIdAtPoint(clientX, clientY);
    if (targetId) {
      dropOn(targetId);
      return;
    }
    // Dropped on empty space -- leave the order alone.
    setDraggingId(null);
    setDropTargetId(null);
  }

  function grab(item: T, index: number) {
    orderBeforeGrab.current = items;
    setGrabbedId(item.id);
    announceAt(item, index, "Grabbed ", " Use the arrow keys to move it.");
  }

  function drop(item: T, index: number) {
    orderBeforeGrab.current = null;
    setGrabbedId(null);
    announceAt(item, index, "Dropped ");
  }

  function cancelGrab(item: T) {
    const before = orderBeforeGrab.current;
    orderBeforeGrab.current = null;
    setGrabbedId(null);
    if (!before) return;
    const index = before.findIndex((row) => row.id === item.id);
    // Only worth a round trip if something actually moved.
    if (before.some((row, i) => row.id !== items[i]?.id)) commitOrder(before);
    setAnnouncement(
      `Reorder cancelled. ${item.name} back at position ${index + 1} of ${before.length}.`
    );
  }

  return {
    draggingId,
    dropTargetId,
    grabbedId,
    announcement,
    moveBy,

    /** Ref callback for the card element, so a mouse drag can use the whole
     * card as its drag image and a touch drag can hit-test against it. */
    registerCard(itemId: string) {
      return (node: HTMLElement | null) => {
        if (node) cardNodes.current.set(itemId, node);
        else cardNodes.current.delete(itemId);
      };
    },

    /** Spread onto the card: the drop half of the native drag. */
    cardProps(itemId: string) {
      return {
        onDragOver(event: React.DragEvent) {
          if (!draggingId) return;
          event.preventDefault();
          if (dropTargetId !== itemId) setDropTargetId(itemId);
        },
        onDragLeave() {
          setDropTargetId((current) => (current === itemId ? null : current));
        },
        onDrop(event: React.DragEvent) {
          event.preventDefault();
          dropOn(itemId);
        },
      };
    },

    /** Spread onto the grip: all three input paths. */
    handleProps(item: T, index: number) {
      const grabbed = grabbedId === item.id;
      return {
        draggable: true,
        "aria-pressed": grabbed,
        onDragStart(event: React.DragEvent) {
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("text/plain", item.id);
          const node = cardNodes.current.get(item.id);
          if (node) event.dataTransfer.setDragImage(node, 20, 20);
          setDraggingId(item.id);
        },
        onDragEnd() {
          setDraggingId(null);
          setDropTargetId(null);
        },
        onPointerDown(event: React.PointerEvent) {
          if (event.pointerType === "mouse") return;
          // Suppresses the scroll/long-press gesture that would otherwise
          // steal the pointer mid-drag; `touch-none` on the handle is the
          // same guarantee at the CSS level, which is the one Safari
          // actually honours.
          event.preventDefault();
          // Keeps pointermove/pointerup targeted at this handle once the
          // finger leaves it, which is the entire drag. Not fatal if the
          // browser refuses (the pointer can already be gone by the time
          // this runs): the drag still starts, it just ends early if the
          // finger slides off -- far better than throwing here and never
          // setting `draggingId` at all.
          try {
            event.currentTarget.setPointerCapture(event.pointerId);
          } catch {
            // Capture is an optimisation, not a precondition.
          }
          pointerDrag.current = { pointerId: event.pointerId, itemId: item.id };
          setDraggingId(item.id);
        },
        onPointerMove(event: React.PointerEvent) {
          const drag = pointerDrag.current;
          if (drag?.pointerId !== event.pointerId) return;
          const overId = itemIdAtPoint(event.clientX, event.clientY);
          setDropTargetId(overId === drag.itemId ? null : overId);
        },
        onPointerUp(event: React.PointerEvent) {
          if (pointerDrag.current?.pointerId !== event.pointerId) return;
          endPointerDrag(event.clientX, event.clientY);
        },
        onPointerCancel(event: React.PointerEvent) {
          if (pointerDrag.current?.pointerId !== event.pointerId) return;
          pointerDrag.current = null;
          setDraggingId(null);
          setDropTargetId(null);
        },
        onKeyDown(event: React.KeyboardEvent) {
          if (event.key === " " || event.key === "Enter") {
            event.preventDefault();
            if (grabbed) drop(item, index);
            else grab(item, index);
            return;
          }
          if (!grabbed) return;
          if (event.key === "ArrowUp" || event.key === "ArrowDown") {
            event.preventDefault();
            moveBy(index, event.key === "ArrowUp" ? -1 : 1);
            return;
          }
          if (event.key === "Escape") {
            event.preventDefault();
            cancelGrab(item);
          }
        },
        // Tabbing away is a drop, not a cancel: the moves are already saved,
        // and silently undoing them because focus left would be a worse
        // surprise than leaving them.
        onBlur() {
          if (!grabbed) return;
          orderBeforeGrab.current = null;
          setGrabbedId(null);
        },
      };
    },
  };
}
