/**
 * Slider — a minimal horizontal slider with a draggable thumb.
 *
 * v3.10.93: built to mirror the desktop's `<input type="range">`
 * visual on the mobile. Supports continuous drag (not just
 * discrete taps). Uses PanResponder for the drag gesture.
 *
 * Props:
 *   min, max, step   — numeric range (step=0 means continuous)
 *   value            — controlled value
 *   onChange         — (value) => void, fires on every drag tick
 *   disabled         — disables drag
 *   trackColor       — flat track color
 *   fillColor        — color of the filled portion (left of thumb)
 *   thumbColor       — thumb color
 *   showValue        — show the numeric value to the right of the
 *                      slider (e.g. "3/5")
 *
 * The track is 32px tall with a 4px surround, the thumb is a
 * 24px circle. Tapping the track jumps the thumb to that
 * position. Dragging the thumb scrubs continuously.
 */

import React, { useRef, useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, PanResponder,
  GestureResponderEvent, LayoutChangeEvent,
} from 'react-native';

export default function Slider({
  min, max, step, value, onChange, disabled,
  trackColor = '#3a3a55',
  fillColor = '#f7931a',
  thumbColor = '#f7931a',
  showValue,
  label,
}: {
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (v: number) => void;
  disabled?: boolean;
  trackColor?: string;
  fillColor?: string;
  thumbColor?: string;
  showValue?: string;
  label?: string;
}) {
  const widthRef = useRef<number>(0);
  const valueRef = useRef<number>(value);
  const disabledRef = useRef<boolean | undefined>(disabled);
  // Mirror the current value + disabled flag into refs so the
  // PanResponder (captured once at mount) can read the latest
  // values without re-creating the responder on every change.
  // v3.10.188: added disabledRef. Before this, the Slider's
  // PanResponder captured the initial `disabled` prop in its
  // closures — so if the parent mounted the Slider with
  // `disabled={true}` (e.g. while a hydrate was pending) and
  // then flipped it to `false` later, the slider was forever
  // stuck in the disabled state. The thumb rendered, the
  // disabledStyle opacity dropped, but the PanResponder's
  // `onStartShouldSetPanResponder: () => !disabled` closure
  // still returned false. Tobe reported this as 'i cant
  // change scale for some reason' on 2026-09-04 19:27.
  valueRef.current = value;
  disabledRef.current = disabled;
  const [trackWidth, setTrackWidth] = useState<number>(0);

  const onLayout = useCallback((e: LayoutChangeEvent) => {
    const w = e.nativeEvent.layout.width;
    widthRef.current = w;
    setTrackWidth(w);
  }, []);

  const clampValue = useCallback((v: number) => {
    if (v < min) return min;
    if (v > max) return max;
    if (step > 0) {
      const snapped = Math.round((v - min) / step) * step + min;
      return Math.max(min, Math.min(max, snapped));
    }
    return v;
  }, [min, max, step]);

  const valueFromX = useCallback((x: number) => {
    const w = widthRef.current;
    if (w <= 0) return valueRef.current;
    const ratio = Math.max(0, Math.min(1, x / w));
    const raw = min + ratio * (max - min);
    return clampValue(raw);
  }, [min, max, clampValue]);

  const panResponder = useRef(
    PanResponder.create({
      // v3.10.188: read disabledRef.current instead of the
      // captured `disabled` prop. The PanResponder is created
      // once at mount; the prop value at that moment would
      // otherwise be locked in forever.
      onStartShouldSetPanResponder: () => !disabledRef.current,
      onMoveShouldSetPanResponder: () => !disabledRef.current,
      onPanResponderGrant: (e: GestureResponderEvent) => {
        if (disabledRef.current) return;
        onChange(valueFromX(e.nativeEvent.locationX));
      },
      onPanResponderMove: (e: GestureResponderEvent) => {
        if (disabledRef.current) return;
        onChange(valueFromX(e.nativeEvent.locationX));
      },
    }),
  ).current;

  const ratio = (value - min) / (max - min);
  const fillWidth = trackWidth * ratio;
  const thumbX = fillWidth - 12; // 12 = half the thumb width (24)
  const disabledStyle = disabled ? styles.disabled : null;

  return (
    <View style={[styles.wrap, disabledStyle]}>
      {label || showValue ? (
        <View style={styles.labelRow}>
          {label ? <Text style={styles.label}>{label}</Text> : <View />}
          {showValue ? <Text style={styles.value}>{showValue}</Text> : null}
        </View>
      ) : null}
      <View
        style={[styles.track, { backgroundColor: trackColor }]}
        onLayout={onLayout}
        {...panResponder.panHandlers}
      >
        <View
          style={[
            styles.fill,
            {
              backgroundColor: fillColor,
              width: Math.max(0, fillWidth),
            },
          ]}
        />
        <View
          style={[
            styles.thumb,
            {
              backgroundColor: thumbColor,
              left: Math.max(0, Math.min(trackWidth - 24, thumbX)),
            },
          ]}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    width: '100%',
  },
  disabled: {
    opacity: 0.5,
  },
  labelRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
  },
  label: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '600',
  },
  value: {
    color: '#f7931a',
    fontSize: 13,
    fontWeight: '700',
  },
  track: {
    width: '100%',
    height: 8,
    borderRadius: 4,
    justifyContent: 'center',
  },
  fill: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    borderRadius: 4,
  },
  thumb: {
    position: 'absolute',
    width: 24,
    height: 24,
    borderRadius: 12,
    top: -8,
    elevation: 3,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.4,
    shadowRadius: 2,
  },
});
