#Requires AutoHotkey v2.0

LoadBidClickMapV2()
{
    global SoldBtn := ReadBidPointV2("SoldBtn", [788, 788])
    global PassBtn := ReadBidPointV2("PassBtn", [696, 788])
    global NextBtn := ReadBidPointV2("NextBtn", [877, 794])
    global CopyPriceArea := ReadBidPointV2("CopyPriceArea", [1637, 690])
    global InternetBtn := ReadBidPointV2("InternetBtn", [1072, 803])
    global CompetingBtn := ReadBidPointV2("CompetingBtn", [975, 803])
    global PriceBtn := ReadBidPointV2("PriceBtn", [1050, 725])
    global FairBtn := ReadBidPointV2("FairBtn", [964, 676])
    global GoingBtn := ReadBidPointV2("GoingBtn", [828, 681])
    global ClockClick := ReadBidPointV2("ClockClick", [1796, 140])
    global LastCallBtn := ReadBidPointV2("LastCallBtn", [715, 681])
    global CheckButtonArea := ReadBidRectV2("CheckButtonArea", [1031, 769, 1135, 823])
    global OCRArea := ReadOCRRectV2("OCRArea", [1637, 690, 150, 30])
}

ReadBidPointV2(key, defaultPoint)
{
    raw := IniRead(A_ScriptDir "\BidClickMap.ini", "Points", key, "")
    if (raw = "")
        return defaultPoint

    parts := StrSplit(raw, ",")
    if (parts.Length < 2)
        return defaultPoint

    return [Trim(parts[1]) + 0, Trim(parts[2]) + 0]
}

ReadBidRectV2(key, defaultRect)
{
    raw := IniRead(A_ScriptDir "\BidClickMap.ini", "Search", key, "")
    if (raw = "")
        return defaultRect

    parts := StrSplit(raw, ",")
    if (parts.Length < 4)
        return defaultRect

    return [Trim(parts[1]) + 0, Trim(parts[2]) + 0, Trim(parts[3]) + 0, Trim(parts[4]) + 0]
}

ReadOCRRectV2(key, defaultRect)
{
    raw := IniRead(A_ScriptDir "\BidClickMap.ini", "OCR", key, "")
    if (raw = "")
        return defaultRect

    parts := StrSplit(raw, ",")
    if (parts.Length < 4)
        return defaultRect

    return [Trim(parts[1]) + 0, Trim(parts[2]) + 0, Trim(parts[3]) + 0, Trim(parts[4]) + 0]
}
