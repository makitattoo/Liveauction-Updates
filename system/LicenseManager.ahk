#Requires AutoHotkey v2.0
#Warn LocalSameAsGlobal, Off
; ===============================
; LICENSE MANAGER - GITHUB GIST MODE
; ===============================
; HWID-based licensing via GitHub Gist (plain text, one license per line)
; Format: HWID|USER|EXPIRY|KEY

; Configuration
global GIST_URL := "https://gist.githubusercontent.com/makitattoo/bdcb9f696bb581263d4b8f4664fec9c8/raw/gistfile1.txt"
global LICENSE_FILE := A_AppData "\AuctionHelper\license.json"
global LICENSE_STATUS_FILE := A_ScriptDir "\AuctionSessions.ini"

; ===== HWID =====

GenerateHWID() {
    hwid := ""
    
    ; Method 1: Try HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Cryptography
    try {
        windowsID := RegRead("HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Cryptography", "MachineGuid")
        if (windowsID && windowsID != "") {
            windowsID := StrReplace(windowsID, "-", "")
            hwid := SubStr(windowsID, 1, 24)
            if (hwid != "")
                return hwid
        }
    } catch {
    }
    
    ; Method 2: Try WMI Win32_ComputerSystemProduct
    try {
        objWMIService := ComObject("WinMgmts:")
        colItems := objWMIService.ExecQuery("Select * from Win32_ComputerSystemProduct")
        for objItem in colItems {
            if (objItem.UUID && objItem.UUID != "") {
                uuid := StrReplace(objItem.UUID, "-", "")
                hwid := SubStr(uuid, 1, 24)
                if (hwid != "")
                    return hwid
            }
        }
    } catch {
    }
    
    ; Method 3: Try WMI Win32_BIOS SerialNumber
    try {
        objWMIService := ComObject("WinMgmts:")
        colItems := objWMIService.ExecQuery("Select * from Win32_BIOS")
        for objItem in colItems {
            if (objItem.SerialNumber && objItem.SerialNumber != "") {
                serial := objItem.SerialNumber
                ; Pad to 24 chars
                hwid := SubStr(serial . "000000000000000000000000", 1, 24)
                if (hwid != "")
                    return hwid
            }
        }
    } catch {
    }
    
    ; Method 4: Try WMI Win32_BaseBoard SerialNumber
    try {
        objWMIService := ComObject("WinMgmts:")
        colItems := objWMIService.ExecQuery("Select * from Win32_BaseBoard")
        for objItem in colItems {
            if (objItem.SerialNumber && objItem.SerialNumber != "") {
                serial := objItem.SerialNumber
                hwid := SubStr(serial . "000000000000000000000000", 1, 24)
                if (hwid != "")
                    return hwid
            }
        }
    } catch {
    }
    
    ; Method 5: Try WMI Win32_DiskDrive SerialNumber
    try {
        objWMIService := ComObject("WinMgmts:")
        colItems := objWMIService.ExecQuery("Select * from Win32_DiskDrive")
        for objItem in colItems {
            if (objItem.SerialNumber && objItem.SerialNumber != "") {
                serial := objItem.SerialNumber
                hwid := SubStr(serial . "000000000000000000000000", 1, 24)
                if (hwid != "")
                    return hwid
            }
        }
    } catch {
    }
    
    ; Fallback: Use ComputerName + fallback
    try {
        computerName := ComObject("WinMgmts:").ExecQuery("Select * from Win32_ComputerSystem").__Item(1).Name
        if (computerName != "") {
            hwid := SubStr(computerName . "000000000000000000000000", 1, 24)
            return hwid
        }
    } catch {
    }
    
    ; Final fallback
    return "NOMACHINEGUID00000000000"
}

GetMACAddress() {
    mac := ""

    ; --- Method 1: WMI IPEnabled adapters ---
    try {
        objWMIService := ComObject("WinMgmts:")
        colItems := objWMIService.ExecQuery("Select * from Win32_NetworkAdapterConfiguration where IPEnabled=true")
        for objItem in colItems {
            if (objItem.MACAddress && objItem.MACAddress != "") {
                mac := StrReplace(objItem.MACAddress, ":", "")
                break
            }
        }
    } catch {
        mac := ""
    }

    ; --- Method 2: WMI ALL adapters (not just IPEnabled) ---
    if (mac = "") {
        try {
            objWMIService := ComObject("WinMgmts:")
            colItems := objWMIService.ExecQuery("Select * from Win32_NetworkAdapterConfiguration")
            for objItem in colItems {
                m := objItem.MACAddress
                if (m && m != "" && !InStr(m, "00:00:00:00:00:00")) {
                    mac := StrReplace(m, ":", "")
                    break
                }
            }
        } catch {
            mac := ""
        }
    }

    ; --- Method 3: WMI Win32_NetworkAdapter (physical only) ---
    if (mac = "") {
        try {
            objWMIService := ComObject("WinMgmts:")
            colItems := objWMIService.ExecQuery("Select * from Win32_NetworkAdapter where PhysicalAdapter=True")
            for objItem in colItems {
                m := objItem.MACAddress
                if (m && m != "" && !InStr(m, "00:00:00:00:00:00")) {
                    mac := StrReplace(m, ":", "")
                    break
                }
            }
        } catch {
            mac := ""
        }
    }

    ; --- Method 4: getmac.exe command line ---
    if (mac = "") {
        try {
            tempFile := A_Temp "\getmac_out.txt"
            RunWait('cmd /c getmac /fo csv /nh > "' tempFile '"', , "Hide")
            if FileExist(tempFile) {
                raw := FileRead(tempFile)
                FileDelete(tempFile)
                ; Parse first line: "XX-XX-XX-XX-XX-XX","\Device\..."
                if RegExMatch(raw, "([0-9A-Fa-f]{2}-[0-9A-Fa-f]{2}-[0-9A-Fa-f]{2}-[0-9A-Fa-f]{2}-[0-9A-Fa-f]{2}-[0-9A-Fa-f]{2})", &m)
                    mac := StrReplace(m[1], "-", "")
            }
        } catch {
            mac := ""
        }
    }

    ; --- Method 5: ipconfig /all ---
    if (mac = "") {
        try {
            tempFile := A_Temp "\ipconfig_out.txt"
            RunWait('cmd /c ipconfig /all > "' tempFile '"', , "Hide")
            if FileExist(tempFile) {
                raw := FileRead(tempFile)
                FileDelete(tempFile)
                if RegExMatch(raw, "Physical Address[.\s]+:\s+([0-9A-Fa-f]{2}-[0-9A-Fa-f]{2}-[0-9A-Fa-f]{2}-[0-9A-Fa-f]{2}-[0-9A-Fa-f]{2}-[0-9A-Fa-f]{2})", &m)
                    mac := StrReplace(m[1], "-", "")
            }
        } catch {
            mac := ""
        }
    }

    ; Final fallback - use a hash of the machine name so it's still unique
    if (mac = "") {
        try {
            name := EnvGet("COMPUTERNAME")
            if (name = "")
                name := "DEFAULTPC"
            ; Pad or hash to 12 chars
            mac := SubStr(name . "000000000000", 1, 12)
        } catch {
            mac := "FALLBACK00000"
        }
    }

    ; Return first 12 chars of MAC for consistency
    return SubStr(mac, 1, 12)
}

; ===== BUILD COMBINED IDENTIFIER =====

GetCombinedIdentifier() {
    hwid := GenerateHWID()
    mac := GetMACAddress()
    return hwid . mac  ; 24 + 12 = 36 chars total
}

; ===== LICENSE DIALOG =====

ShowLicenseDialog(identifier := "", reason := "") {
    if (identifier = "")
        identifier := GetCombinedIdentifier()

    licenseGui := Gui()
    licenseGui.BackColor := "111A13"
    licenseGui.OnEvent("Close", GuiClose)

    if (reason != "")
        licenseGui.Add("Text", "w420 h50 cFF4D4F Center Background111A13", "LICENSE REQUIRED - " . reason)
    else
        licenseGui.Add("Text", "w420 h50 c00D94A Center Background111A13", "LICENSE REQUIRED")

    licenseGui.Add("Text", "w420 h2 Background00D94A", "")
    licenseGui.Add("Text", "w420 h20 c00D94A", "Your machine ID (HWID+MAC):")
    licenseGui.Add("Edit", "w420 h30 c00FF66 Background111A13 ReadOnly -TabStop vHWIDDisplay", identifier)
    licenseGui.Add("Button", "w200 h30 c00D94A Background111A13", "Copy ID").OnEvent("Click", CopyHWIDClick)
    licenseGui.Add("Text", "w420 h20", "")
    licenseGui.Add("Text", "w420 h20 c00D94A", "Paste License Key:")
    licenseGui.Add("Edit", "w420 h60 c00FF66 Background111A13 vLicenseKeyInput", "")
    licenseGui.Add("Button", "w200 h30 c00D94A Background111A13", "Activate License").OnEvent("Click", ActivateLicenseClick)

    licenseGui.Add("Text", "w420 h40 c888888", "License Key Format: HEX string (80+ characters)")

    licenseGui.Add("Text", "w420 h10", "")
    licenseGui.Add("Button", "w200 h30 cFF4D4F Background111A13", "Exit App").OnEvent("Click", ExitAppClick)

    licenseGui.Show("w440 h420")
    licenseGui.Title := "License Activation"

    while (licenseGui)
        Sleep(100)

    return

    CopyHWIDClick(GuiCtrlObj, Info) {
        A_Clipboard := identifier
        ToolTip("ID Copied!")
    }

    ActivateLicenseClick(GuiCtrlObj, Info) {
        licenseKey := licenseGui["LicenseKeyInput"].Value
        if (licenseKey = "") {
            MsgBox("Please paste your license key", "Error", 0x10)
            return
        }

        ; First: Verify the key locally (format and identifier match)
        if (!VerifyLicenseFormat(identifier, licenseKey)) {
            MsgBox("✗ License key is invalid or Machine ID doesn't match.`n`nMake sure you pasted the correct key.", "Activation Failed", 0x10)
            licenseGui["LicenseKeyInput"].Value := ""
            return
        }

        ; Second: Check if this license exists in Gist
        if (!VerifyLicenseInGist(identifier, licenseKey)) {
            MsgBox("✗ License not found in server or has been revoked.`n`nContact the developer.", "Server Verification Failed", 0x10)
            licenseGui["LicenseKeyInput"].Value := ""
            return
        }

        ; Third: Save license locally
        SetActivationStatus(1)
        MsgBox("    ✓ License Activated Successfully ✓`n`n    You can now use the AI    ", "License Activated", 0x40)
        licenseGui.Destroy()
        licenseGui := ""
        ; Restart the script so the bot starts fresh with valid license
        Run(A_ScriptFullPath)
        ExitApp
    }

    ExitAppClick(GuiCtrlObj, Info) {
        licenseGui.Destroy()
        licenseGui := ""
        ExitApp
    }

    GuiClose(GuiCtrlObj) {
        licenseGui := ""
        ExitApp
    }
}

; ===== FETCH FROM GIST =====

FetchLicenseFromGist() {
    debugLog := A_Temp "\license_debug.log"
    timestamp := A_Now

    try {
        FileAppend(timestamp . " - [API] Fetching from GitHub Gist...`n", debugLog)

        req := ComObject("WinHttp.WinHttpRequest.5.1")
        ; Always fetch latest version (no caching)
        url := GIST_URL . "?t=" . A_Now
        req.Open("GET", url, false)
        req.SetRequestHeader("Cache-Control", "no-cache")
        req.Send()

        response := req.ResponseText

        if (req.Status != 200) {
            FileAppend(timestamp . " - [API] Gist unreachable (status: " . req.Status . ")`n", debugLog)
            return ""
        }

        ; Server is reachable - return all content (even if just header)
        FileAppend(timestamp . " - [API] Response length: " . StrLen(response) . "`n", debugLog)
        return response

    } catch {
        FileAppend(timestamp . " - [API] Exception occurred`n", debugLog)
        return ""
    }
}

; ===== STARTUP CHECK =====

VerifyLicenseFormat(hwid, licenseKey) {
    decrypted := DecryptLicense(licenseKey)

    if (decrypted = "" || StrLen(decrypted) < 44) {
        return false
    }

    ; Extract full identifier (HWID+MAC, 36 chars) and expiry date (8 chars: YYYYMMDD)
    keyIdentifier := SubStr(decrypted, 1, 36)
    dateStr := SubStr(decrypted, 37, 8)
    expiryDate := SubStr(dateStr, 1, 4) . "-" . SubStr(dateStr, 5, 2) . "-" . SubStr(dateStr, 7, 2)

    ; Validate identifier match (full HWID+MAC)
    if (keyIdentifier != hwid) {
        return false
    }

    ; Validate expiry date format
    if (!RegExMatch(expiryDate, "^\d{4}-\d{2}-\d{2}$")) {
        return false
    }

    ; Validate not expired
    expiryTime := DateToUnix(expiryDate)
    currentTime := DateToUnix(A_Now)
    if (expiryTime < currentTime) {
        return false
    }

    return true
}

VerifyLicenseInGist(hwid, licenseKey) {
    hwid12 := SubStr(hwid, 1, 12)  ; First 12 chars for Gist display line
    
    ; Fetch Gist
    serverData := FetchLicenseFromGist()
    if (serverData = "") {
        return false
    }

    ; Search for matching license line by HWID only
    ; If HWID exists in Gist and not expired, license is valid
    lines := StrSplit(serverData, "`n")
    for line in lines {
        line := Trim(line)
        if (line = "" || line = "HWID|USER|EXPIRY|KEY")
            continue
        parts := StrSplit(line, "|")
        ; Gist format: HWID12|USER|EXPIRY|KEY
        if (parts.Length >= 4 && parts[1] = hwid12) {
            expiryDate := Trim(parts[3])
            expiryTime := DateToUnix(expiryDate)
            currentTime := DateToUnix(A_Now)
            
            ; License is valid if HWID is in Gist and not expired
            if (currentTime <= expiryTime) {
                return true
            } else {
                return false  ; Found but expired
            }
        }
    }

    ; HWID not found in Gist (revoked/missing)
    return false
}

CheckLicense() {
    debugLog := A_Temp "\license_debug.log"
    timestamp := A_Now

    FileAppend(timestamp . " - [BIDHEL PER STARTUP] CheckLicense() STARTED`n", debugLog)

    identifier := GetCombinedIdentifier()
    hwid12 := SubStr(identifier, 1, 12)
    FileAppend(timestamp . " - [BIDHEL PER STARTUP] Machine ID: " . identifier . "`n", debugLog)

    ; STEP 1: Check for saved license key locally (shared with AAMICRO)
    savedLicenseKey := GetSavedLicenseKey()
    
    if (savedLicenseKey != "") {
        FileAppend(timestamp . " - [BIDHEL PER STARTUP] Found saved license key in .ini (shared with AAMICRO)`n", debugLog)
        
        ; Verify the saved key format and expiry locally
        if (VerifyLicenseFormat(identifier, savedLicenseKey)) {
            FileAppend(timestamp . " - [BIDHEL PER STARTUP] Saved license is VALID (not expired)`n", debugLog)
            SetActivationStatus(1)
            return true
        } else {
            FileAppend(timestamp . " - [BIDHEL PER STARTUP] Saved license EXPIRED`n", debugLog)
            DeleteSavedLicenseKey()
            ; Show dialog instead of exiting
            ShowLicenseDialog(identifier, "License Expired - Get New Key")
            ExitApp
        }
    }

    ; STEP 2: Try to activate from Gist
    FileAppend(timestamp . " - [BIDHEL PER STARTUP] No saved key - checking Gist...`n", debugLog)
    
    serverData := FetchLicenseFromGist()
    if (serverData = "") {
        FileAppend(timestamp . " - [BIDHEL PER STARTUP] Gist unreachable - showing HWID dialog`n", debugLog)
        ShowLicenseDialog(identifier, "Internet Connection Required")
        ExitApp
    }

    ; Search Gist for this HWID
    lines := StrSplit(serverData, "`n")
    for line in lines {
        line := Trim(line)
        if (line = "" || line = "HWID|USER|EXPIRY|KEY")
            continue
        parts := StrSplit(line, "|")
        if (parts.Length >= 4 && parts[1] = hwid12) {
            licenseKey := parts[4]
            expiryDate := parts[3]
            expiryTime := DateToUnix(expiryDate)
            currentTime := DateToUnix(A_Now)
            
            if (currentTime <= expiryTime) {
                FileAppend(timestamp . " - [BIDHEL PER STARTUP] Found valid license in Gist - saving`n", debugLog)
                SaveLicenseKey(licenseKey, expiryDate)
                SetActivationStatus(1)
                return true
            } else {
                FileAppend(timestamp . " - [BIDHEL PER STARTUP] License in Gist EXPIRED`n", debugLog)
                ShowLicenseDialog(identifier, "License Expired - Get New Key")
                ExitApp
            }
        }
    }

    ; HWID not found in Gist
    FileAppend(timestamp . " - [BIDHEL PER STARTUP] HWID not found in Gist - show activation dialog`n", debugLog)
    ShowLicenseDialog(identifier)
    ExitApp
}

; ===== 10-SECOND TIMER =====

LicenseCheckTimer() {
    debugLog := A_Temp "\license_debug.log"
    timestamp := A_Now

    FileAppend(timestamp . " - [TIMER] LicenseCheckTimer() RUNNING`n", debugLog)

    identifier := GetCombinedIdentifier()
    hwid12 := SubStr(identifier, 1, 12)

    ; Check if we still have a valid saved key
    savedLicenseKey := GetSavedLicenseKey()
    
    if (savedLicenseKey = "") {
        FileAppend(timestamp . " - [TIMER] No saved key - unexpected`n", debugLog)
        return
    }

    ; Verify the saved key is still valid (not expired)
    if (!VerifyLicenseFormat(identifier, savedLicenseKey)) {
        FileAppend(timestamp . " - [TIMER] Saved license EXPIRED - stopping`n", debugLog)
        DeleteSavedLicenseKey()
        SetTimer(LicenseCheckTimer, 0)  ; Stop timer
        MsgBox("Your license has expired.", "License Expired", 0x10)
        ExitApp
    }

    ; If internet available, verify against Gist to check for revocation
    serverData := FetchLicenseFromGist()
    if (serverData = "") {
        ; No internet - just continue, don't exit
        FileAppend(timestamp . " - [TIMER] Server unreachable - continuing`n", debugLog)
        return
    }

    ; Server reachable - verify license is still in Gist
    if (VerifyLicenseInGist(identifier, savedLicenseKey)) {
        FileAppend(timestamp . " - [TIMER] License verified in Gist - OK`n", debugLog)
        SetActivationStatus(1)
    } else {
        ; License NOT in Gist (revoked/missing)
        FileAppend(timestamp . " - [TIMER] License revoked in Gist - stopping`n", debugLog)
        SetTimer(LicenseCheckTimer, 0)  ; Stop timer FIRST
        DeleteSavedLicenseKey()  ; Delete .ini immediately
        FileAppend(timestamp . " - [TIMER] .ini deleted, setting flag for main script`n", debugLog)
        
        ; Set flag for main script to detect and exit
        global licenseRevoked := true
        
        ; Also try to show messagebox and exit (may not work if bot is busy)
        MsgBox("Your license has been revoked.", "License Revoked", 0x10)
        FileAppend(timestamp . " - [TIMER] ExitApp called`n", debugLog)
        ExitApp(0)
    }
}

; ===== HELPERS =====

DateToUnix(dateString) {
    if (RegExMatch(dateString, "^(\d{4})-(\d{2})-(\d{2})$", &m))
        return Integer(m[1] . m[2] . m[3])
    ; Also handle AHK A_Now format YYYYMMDDHHMMSS
    if (RegExMatch(dateString, "^(\d{4})(\d{2})(\d{2})", &m))
        return Integer(m[1] . m[2] . m[3])
    return 0
}

DecryptLicense(encryptedKey) {
    secretKey := "AUCTIONHELPER2025"

    if (Mod(StrLen(encryptedKey), 2) != 0)
        return ""

    decrypted := ""
    keyLen := StrLen(secretKey)

    loop StrLen(encryptedKey) // 2 {
        hexPair := SubStr(encryptedKey, (A_Index - 1) * 2 + 1, 2)
        xorCode := Integer("0x" . hexPair)
        keyChar := SubStr(secretKey, Mod(A_Index - 1, keyLen) + 1, 1)
        originalCode := xorCode ^ Ord(keyChar)
        decrypted .= Chr(originalCode)
    }

    return decrypted
}

GetActivationStatus() {
    if (!FileExist(LICENSE_STATUS_FILE))
        return 0
    try {
        status := IniRead(LICENSE_STATUS_FILE, "License", "activated", "0")
        return Integer(status)
    } catch {
        return 0
    }
}

SetActivationStatus(value) {
    try {
        IniWrite(value, LICENSE_STATUS_FILE, "License", "activated")
        return true
    } catch {
        return false
    }
}

GetSavedLicenseKey() {
    if (!FileExist(LICENSE_STATUS_FILE))
        return ""
    try {
        key := IniRead(LICENSE_STATUS_FILE, "License", "serial_key", "")
        return key
    } catch {
        return ""
    }
}

SaveLicenseKey(licenseKey, expiryDate) {
    try {
        IniWrite(licenseKey, LICENSE_STATUS_FILE, "License", "serial_key")
        IniWrite(expiryDate, LICENSE_STATUS_FILE, "License", "expiry_date")
        return true
    } catch {
        return false
    }
}

DeleteSavedLicenseKey() {
    try {
        IniDelete(LICENSE_STATUS_FILE, "License", "serial_key")
        IniDelete(LICENSE_STATUS_FILE, "License", "expiry_date")
        return true
    } catch {
        return false
    }
}
