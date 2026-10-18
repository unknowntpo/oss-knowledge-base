<script setup lang="ts">
/**
 * Spec 024 DM2: 淺色 / 深色 / 跟隨系統 on the top bar. A radio group: arrow keys move and select,
 * Tab enters at the checked option. Text labels from 1440 px, icons with the same accessible names
 * below. At 420 px and below the bar has no room for three options next to the freshness pill, so
 * one button shows the current choice and moves to the next on each press.
 */
import { ref } from "vue";

import { useI18n } from "../i18n";
import { chooseTheme, currentThemeChoice, THEME_CHOICES, type ThemeChoice } from "../theme";

const { t } = useI18n();
const choice = ref<ThemeChoice>(currentThemeChoice());
const buttons = ref<HTMLButtonElement[]>([]);
const ICON: Readonly<Record<ThemeChoice, string>> = { light: "☀", dark: "☾", system: "◐" };

function select(next: ThemeChoice, focus = false) {
  chooseTheme(next);
  choice.value = next;
  if (focus) buttons.value[THEME_CHOICES.indexOf(next)]?.focus();
}

const next = (current: ThemeChoice) => THEME_CHOICES[(THEME_CHOICES.indexOf(current) + 1) % THEME_CHOICES.length]!;

function onKey(event: KeyboardEvent, index: number) {
  const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
  if (step === 0) return;
  event.preventDefault();
  select(THEME_CHOICES[(index + step + THEME_CHOICES.length) % THEME_CHOICES.length]!, true);
}
</script>

<template>
  <div class="theme-control" role="radiogroup" :aria-label="t('theme.label')" data-theme-control>
    <button
      v-for="(option, index) in THEME_CHOICES"
      :key="option"
      ref="buttons"
      type="button"
      role="radio"
      class="theme-option"
      :aria-checked="choice === option"
      :tabindex="choice === option ? 0 : -1"
      :data-theme-choice="option"
      :title="t(`theme.${option}`)"
      @click="select(option)"
      @keydown="onKey($event, index)"
    >
      <span class="theme-icon" aria-hidden="true">{{ ICON[option] }}</span>
      <span class="theme-text">{{ t(`theme.${option}`) }}</span>
    </button>
  </div>
  <button
    type="button"
    class="theme-cycle"
    :aria-label="t('theme.cycle', { current: t(`theme.${choice}`), next: t(`theme.${next(choice)}`) })"
    :title="t('theme.cycle', { current: t(`theme.${choice}`), next: t(`theme.${next(choice)}`) })"
    :data-theme-current="choice"
    data-theme-cycle
    @click="select(next(choice))"
  ><span aria-hidden="true">{{ ICON[choice] }}</span></button>
</template>
