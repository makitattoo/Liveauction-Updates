#Requires AutoHotkey v2.0
#Warn LocalSameAsGlobal, Off

; ExtensionButton.ahk - Chrome Extension-based button detection
; Replaces pixel search (CheckButton) with file-based detection from Chrome Extension

class ExtensionButton {
    static buttonStateFile := A_Temp "\bidhelper_button_state.txt"
    static lastCheckTime := 0
    static cacheDuration := 100  ; Cache for 100ms to avoid excessive file reads
    static cachedState := false
    
    ; Check if button is visible based on Chrome Extension DOM reading
    static IsVisible() {
        ; Check cache first
        currentTime := A_TickCount
        if (currentTime - this.lastCheckTime < this.cacheDuration) {
            return this.cachedState
        }
        
        ; Read from file written by Chrome Extension
        state := this.ReadButtonState()
        
        ; Update cache
        this.cachedState := state
        this.lastCheckTime := currentTime
        
        return state
    }
    
    ; Read button state from file
    static ReadButtonState() {
        try {
            if (!FileExist(this.buttonStateFile))
                return false
            content := Trim(FileRead(this.buttonStateFile))
            return (content = "visible")
        } catch {
            return false
        }
    }
    
    ; Get raw button state text
    static GetRawState() {
        try {
            if (!FileExist(this.buttonStateFile))
                return "unknown"
            return Trim(FileRead(this.buttonStateFile))
        } catch {
            return "error"
        }
    }
    
    ; Force refresh (bypass cache)
    static ForceCheck() {
        this.lastCheckTime := 0
        return this.IsVisible()
    }
}

; Legacy function wrappers for compatibility
CheckButton() {
    global pauseCountSession, pressCount, scriptPaused, checkButtonLatched
    
    if (!pressCount)
        pressCount := 0
    
    if scriptPaused
    {
        checkButtonLatched := false
        return false
    }
    
    ; Check if button is visible via extension
    if ExtensionButton.IsVisible()
    {
        if checkButtonLatched
            return false
        
        checkButtonLatched := true
        
        ; Pause session at lots 11-14 (temporary mode)
        if (pressCount >= 11 && pressCount <= 14)
        {
            pauseCountSession := true
            ; UpdateSessionWindow()  ; Legacy - defined in AAMICRO.ahk
        }
        
        ; SignalRepeatCurrentF8Step()  ; Legacy - defined in AAMICRO.ahk
        ; SetAutoClickStatus(1)  ; Legacy - defined in AAMICRO.ahk
        ; LaunchCurrentCalculatorSubScript(1, true)  ; Legacy - defined in AAMICRO.ahk
        Sleep 500
        return true
    }
    
    checkButtonLatched := false
    return false
}

IsCheckButtonVisible() {
    return ExtensionButton.IsVisible()
}
