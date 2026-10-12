; Installer hooks shared by both editions (see bundle.windows.nsis.installerHooks).
;
; The standard and AI editions are the same app in the same folder, so either
; can be installed over the other. The AI edition's extras are the AI files in
; $INSTDIR\ai, plus the command-line tool for AI assistants (magicminutes.exe
; and its AGENTS.md). Clearing them before installing means:
;   - standard over AI removes the 500 MB of AI files and the command-line
;     tool, so the app really is the standard edition afterwards;
;   - AI over AI (an update, maybe with a new model) doesn't leave the old model
;     behind next to the new one. The AI installer puts its own copies back.
; Notes and settings live elsewhere (%APPDATA%) and are never touched.

!macro NSIS_HOOK_PREINSTALL
  RMDir /r "$INSTDIR\ai"
  Delete "$INSTDIR\magicminutes.exe"
  Delete "$INSTDIR\AGENTS.md"
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  RMDir /r "$INSTDIR\ai"
  Delete "$INSTDIR\magicminutes.exe"
  Delete "$INSTDIR\AGENTS.md"
!macroend
