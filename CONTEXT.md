# pen2figma

Copies designs from Pen.dev into Figma so they are visible to people who work in Figma. Pen is where designs are made; Figma is where they are shown and commented on.

## Language

**Pen frame**:
A node in a `.pen` file, identified by its Pen node ID (e.g. `pO0Ah`), that the user wants to see in Figma.
_Avoid_: Pen node, design, screen

**Pen selection**:
The Pen frames currently selected in the active Pen canvas — the default thing a Copy takes when no IDs are given.
_Avoid_: Current frame, active frame

**Copy** (verb):
A one-way, one-time transfer of a Pen frame into Figma. Running it again on the same Pen frame makes another Figma copy; it never updates an earlier one.
_Avoid_: Sync, import, export, push

**Figma copy**:
The Figma frame produced by one Copy. Once created it is owned by Figma and may be edited there; pen2figma never touches it again.
_Avoid_: Mirror, synced frame, replica
