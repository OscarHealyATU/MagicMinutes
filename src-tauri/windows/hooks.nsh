; Installer hooks shared by both editions (see bundle.windows.nsis.installerHooks).
;
; The standard and AI editions are the same app in the same folder, so either
; can be installed over the other. The AI files live in $INSTDIR\ai; clearing
; that folder before installing means:
;   - standard over AI removes the 500 MB of AI files, so the app really is the
;     standard edition afterwards;
;   - AI over AI (an update, maybe with a new model) doesn't leave the old model
;     behind next to the new one.
; Notes and settings live elsewhere (%APPDATA%) and are never touched.

!macro NSIS_HOOK_PREINSTALL
  RMDir /r "$INSTDIR\ai"
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  RMDir /r "$INSTDIR\ai"
!macroend
