import Foundation

/// The contact form (screen 12): what is checked before the app sends it, in the server's own plain words (they match
/// apps/api/src/public/quote.ts, so a message reads the same whichever side catches the mistake).
public enum ContactField: String, CaseIterable, Sendable, Hashable {
    case firstName, lastName, phone, email, zip, consent
}

public enum ContactValidation {
    public static let firstNameMessage = "Please enter your first name."
    public static let lastNameMessage = "Please enter your last name."
    public static let phoneMessage = "That doesn't look like a US phone number."
    public static let emailMessage = "That doesn't look like an email address."
    public static let zipMessage = "Please enter a 5-digit ZIP code."
    public static let consentMessage = "Please check the box so we can call or email you."

    /// What is wrong with the form, by field (empty when it can be sent).
    public static func errors(_ c: HomeownerContact) -> [ContactField: String] {
        var out: [ContactField: String] = [:]
        if c.firstName.trimmingCharacters(in: .whitespaces).isEmpty { out[.firstName] = firstNameMessage }
        if c.lastName.trimmingCharacters(in: .whitespaces).isEmpty { out[.lastName] = lastNameMessage }
        if PhoneFormat.digits(c.phone) == nil { out[.phone] = phoneMessage }
        if !isEmail(c.email) { out[.email] = emailMessage }
        if !isZip(c.zip) { out[.zip] = zipMessage }
        if !c.contactConsent { out[.consent] = consentMessage }
        return out
    }

    public static func isEmail(_ text: String) -> Bool {
        let t = text.trimmingCharacters(in: .whitespaces)
        guard t.count <= 254, !t.contains(" "), let at = t.firstIndex(of: "@"), t.firstIndex(of: "@") == t.lastIndex(of: "@") else { return false }
        let local = t[t.startIndex..<at], domain = t[t.index(after: at)...]
        guard !local.isEmpty, let dot = domain.lastIndex(of: "."), dot != domain.startIndex else { return false }
        return domain.distance(from: dot, to: domain.endIndex) > 2 && !domain.hasPrefix(".") && !domain.hasSuffix(".")
    }

    /// A 5-digit ZIP (a ZIP+4 also passes: its first five are used).
    public static func isZip(_ text: String) -> Bool {
        let t = text.trimmingCharacters(in: .whitespaces)
        let parts = t.split(separator: "-", omittingEmptySubsequences: false)
        guard parts.count <= 2, let first = parts.first, first.count == 5, first.allSatisfy({ $0.isASCII && $0.isNumber }) else { return false }
        return parts.count == 1 || (parts[1].count == 4 && parts[1].allSatisfy { $0.isASCII && $0.isNumber })
    }

    /// The form as it is sent: trimmed names, the ZIP's first five digits, the phone in the form the server reads.
    public static func prepared(_ c: HomeownerContact) -> HomeownerContact {
        var out = c
        out.firstName = c.firstName.trimmingCharacters(in: .whitespaces)
        out.lastName = c.lastName.trimmingCharacters(in: .whitespaces)
        out.email = c.email.trimmingCharacters(in: .whitespaces)
        out.zip = String(c.zip.trimmingCharacters(in: .whitespaces).prefix(5))
        if let d = PhoneFormat.digits(c.phone) { out.phone = PhoneFormat.display(d) }
        return out
    }
}

public enum PhoneFormat {
    /// The ten digits of a US number typed any way ("+1 (501) 555-0177", "501.555.0177"), or nil. The area code and the
    /// exchange cannot start with 0 or 1.
    public static func digits(_ typed: String) -> String? {
        var d = typed.filter { $0.isASCII && $0.isNumber }
        if d.count == 11, d.hasPrefix("1") { d.removeFirst() }
        guard d.count == 10, let a = d.first, let e = d.dropFirst(3).first, a >= "2", e >= "2" else { return nil }
        return d
    }

    /// "(501) 555-0177" from ten digits.
    public static func display(_ tenDigits: String) -> String {
        guard tenDigits.count == 10 else { return tenDigits }
        let a = tenDigits.prefix(3), b = tenDigits.dropFirst(3).prefix(3), c = tenDigits.dropFirst(6)
        return "(\(a)) \(b)-\(c)"
    }

    /// The number as it is being typed: "5", "(50", "(501) 5", "(501) 555-01", ... at most ten digits (a leading 1 is dropped).
    public static func progressive(_ typed: String) -> String {
        var d = typed.filter { $0.isASCII && $0.isNumber }
        if d.hasPrefix("1") && d.count > 10 { d.removeFirst() }
        d = String(d.prefix(10))
        switch d.count {
        case 0: return ""
        case 1...3: return d.count == 3 ? "(\(d)) " : "(\(d)"
        case 4...6: return "(\(d.prefix(3))) \(d.dropFirst(3))"
        default: return "(\(d.prefix(3))) \(d.dropFirst(3).prefix(3))-\(d.dropFirst(6))"
        }
    }
}
