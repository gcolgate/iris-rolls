# Iris Rolls

A Foundry VTT module for the D&D 5e system. It takes over sheet rolls, skips the usual configuration dialogs, always rolls two d20s, and puts advantage, targets, hit/miss, and damage application on the chat card.

We don't use the target mechanism to pick targets, instead, we use selecting.

This release is for testing (including The Forge). Treat it as alpha. It is slowly getting better though.

## Requirements

- Foundry Virtual Tabletop v14
- [D&D 5e](https://foundryvtt.com/packages/dnd5e) 5.3.3 or later (verified on 6.0.1; 5.3.3 is untested)

Do not enable this together with Midi QOL or Ready Set Roll. Those modules also replace 5e roll cards, and Iris Rolls will warn if they are active.

## Install

**From a Manifest URL** (Foundry Setup or The Forge):

```
https://github.com/gcolgate/iris-rolls/releases/latest/download/module.json
```

**From this repo** (local development): copy or clone the `iris-rolls` folder into `{userData}/Data/modules/iris-rolls`.

## What's new in 1.1.8

- Emanation auras such as **Spirit Guardians** place a region that attaches to the caster (you click the token). Iris asks the 5e system to create that region, and only the activity that actually places an area does so — a later save or “enter the aura” activity will not drop a second region.
- Tokens already standing in that live aura are used for enter/turn saves. The caster, and the token the region is attached to, are not auto-selected as targets.
- Recasting replaces the previous region only when a second copy would be illegal: **concentration**, a **self emanation**, or an **instantaneous** area (Fireball leftovers). Timed spells without concentration — Grease, Glyph of Warding, Guardian of Faith, Tiny Hut — keep earlier regions. Another caster’s copy of the same spell is left alone. **Again** and **Replace Region** use the same rule.
- Aura regions pick up damage types from a sibling save or damage activity when the placement activity itself has none, so coloring from **iris-regions** still works. If nothing is found, the region is tagged unknown rather than left untagged.
- **Again** only asks you to place a new region when that activity actually places an area, not because the spell item has a template somewhere else on it.

## What's new in 1.1.7

- Attack and damage cards have a **Crit** / **No Crit** toggle next to bonus damage. It follows the roll by default (red when a natural crit), and turns blue when you override it. Changing advantage, the die, or targets re-syncs it.
- Area regions treat a token as hit if the region intersects its footprint, including Large and larger creatures—not only the center point.
- Iris Rolls only sets a placed region’s color when **iris-regions** is enabled; otherwise Foundry’s default color is left alone.
- **Change Targets** and GM live retarget keep extra selected creatures beyond the spell’s target limit, with a warning. The first cast and slot changes still truncate extras.
- Save activities put applyable effects on the card (for example Slow’s condition) so **Apply** can attach them after failed saves.

## What's new in 1.1.6

- **Total Damage** / **Total Healing** now shows two numbers: the rolled total (dice + bonus), then the sum of damage actually dealt to all targets after hit/miss, saves, resistance, and reactions (for example `44 / 22`). Misses and fully negated damage count as 0 toward the second number.

## What's new in 1.1.5

- An attempt was made to support D&D 5e **5.3.3** on Foundry 14. On 6.0 the system still places the area region; on 5.3.3 Iris places a Scene Region itself so Fireball can work. **This 5.3.3 path has not been tested yet.**

## What's new in 1.1.4

- Requires Foundry VTT v14 and D&D 5e 6.0 (verified on 6.0.1).
- Area spells use Foundry 14 **Scene Regions** instead of measured templates. Tokens standing in the region are selected as targets, including tokens a player does not own.
- Chat cards say **Remove Region** and **Replace Region**. Those buttons delete or replace the region and retarget creatures inside the new one.
- Area regions keep their real circle/cone. Grid-Based is off, and highlight is the shape itself instead of covered grid squares.
- Resistance, immunity, and vulnerability follow D&D 5e 6.0 (including all-damage resistance). Mixed attacks keep types separate, so fire resistance halves only the fire part of something like Flame Sword (slashing + fire).

See the [1.1.8 release notes](https://github.com/gcolgate/iris-rolls/releases/tag/1.1.8). Older notes: [1.1.7](https://github.com/gcolgate/iris-rolls/releases/tag/1.1.7), [1.1.6](https://github.com/gcolgate/iris-rolls/releases/tag/1.1.6), [1.1.5](https://github.com/gcolgate/iris-rolls/releases/tag/1.1.5), [1.1.4](https://github.com/gcolgate/iris-rolls/releases/tag/1.1.4), [1.1.3](https://github.com/gcolgate/iris-rolls/releases/tag/1.1.3), [1.1.2](https://github.com/gcolgate/iris-rolls/releases/tag/1.1.2), [1.1.1](https://github.com/gcolgate/iris-rolls/releases/tag/1.1.1), [1.1.0](https://github.com/gcolgate/iris-rolls/releases/tag/1.1.0).

## How it works

- Rolling from a sheet uses that actor as the roller. Selected tokens are the targets. Players can left-click or box-select tokens they do not own to pick those targets. That is select-only: it does not let them move the token, open its sheet, or change HP.
- If an attack has no other token selected, Iris asks you to select a target before it rolls.
- If you forgot to select someone after the card is up, change targets on the chat card. The GM can also retarget their latest unapplied NPC card just by changing the selection while chat is visible.
- Spells that can be upcast ask for a slot or spell-point level before the card posts. You can still change the level on the card afterward.
- If you forgot advantage or disadvantage, change it on the chat card. Each target can have its own roll, bonus, and advantage mode.
- Area-effect spells place a region. Tokens in the region are selected as targets automatically, including tokens a player does not own. Emanations attach to the caster. You can still override targets on the card, or remove/replace the region. Recasting a concentration or self-emanation aura replaces the old region; lasting areas that are allowed to stack do not.
- Saves are rolled automatically, including Evasion. Advantage, disadvantage, and some other 5e save rules may still need work.
- Apply results with **Apply Damage** or **Apply Effect**. **Apply again** lets you apply a second time without undoing the first.
- Hover damage lines, totals, or a target's applied amount to see each die.
- When a target has a matching reaction, **React** appears on that row. The target's owner or the GM can use it.
- **Again** and **Again no resources** sit at the bottom of the card. Area spells ask you to place a new region first.
- Click the used d20 to reroll or replace it.
- The card also has a description button and an undo button. Used slots, points, and feature uses can be refunded from the card.

## License

MIT. See [LICENSE](LICENSE).

# to do
Do something about echos in the next release
issues with magic weapons and bludgeoning
