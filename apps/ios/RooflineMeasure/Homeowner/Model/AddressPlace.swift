import CoreLocation
import Foundation
import MapKit

/// An address the homeowner picked from the suggestions: what the field shows, and where it is (for the map pin).
struct AddressPlace: Equatable {
    var title: String
    var subtitle: String
    var coordinate: CLLocationCoordinate2D?
    /// "Little Rock, AR 72205" once the place is resolved (city, state and ZIP from the placemark).
    var regionLine: String?

    static func == (a: AddressPlace, b: AddressPlace) -> Bool {
        a.title == b.title && a.subtitle == b.subtitle && a.regionLine == b.regionLine && a.coordinate?.latitude == b.coordinate?.latitude && a.coordinate?.longitude == b.coordinate?.longitude
    }

    /// "305 Ridgeway Dr, Little Rock, AR 72205": the line sent to the server and shown in the field.
    var oneLine: String {
        let region = regionLine ?? Self.trimmedSubtitle(subtitle)
        return region.isEmpty ? title : "\(title), \(region)"
    }

    /// The country is dropped ("Little Rock, AR, United States" -> "Little Rock, AR").
    static func trimmedSubtitle(_ s: String) -> String {
        var out = s
        for tail in [", United States", ", USA", ", US"] where out.hasSuffix(tail) { out = String(out.dropLast(tail.count)) }
        return out
    }
}

/// MapKit's address suggestions as the homeowner types (street addresses only), and the coordinate of the one picked.
@MainActor
final class AddressSearch: NSObject, MKLocalSearchCompleterDelegate {
    private let completer = MKLocalSearchCompleter()
    private(set) var results: [MKLocalSearchCompletion] = []
    var onResults: (([AddressPlace]) -> Void)?

    override init() {
        super.init()
        completer.delegate = self
        completer.resultTypes = .address
    }

    func update(query: String) {
        let q = query.trimmingCharacters(in: .whitespaces)
        guard q.count >= 3 else {
            results = []
            onResults?([])
            return
        }
        completer.queryFragment = q
    }

    nonisolated func completerDidUpdateResults(_ completer: MKLocalSearchCompleter) {
        let items = completer.results
        Task { @MainActor in
            self.results = items
            self.onResults?(items.prefix(5).map { AddressPlace(title: $0.title, subtitle: $0.subtitle, coordinate: nil) })
        }
    }

    nonisolated func completer(_ completer: MKLocalSearchCompleter, didFailWithError error: Error) {
        Task { @MainActor in self.onResults?([]) }
    }

    /// The coordinate of a suggestion (one MKLocalSearch); the place unchanged when the search finds nothing.
    func resolve(_ place: AddressPlace) async -> AddressPlace {
        let request = MKLocalSearch.Request()
        request.naturalLanguageQuery = place.oneLine
        request.resultTypes = .address
        guard let item = try? await MKLocalSearch(request: request).start().mapItems.first else { return place }
        var out = place
        let pm = item.placemark
        out.coordinate = pm.coordinate
        if let city = pm.locality, let state = pm.administrativeArea {
            out.regionLine = [city + ",", state, pm.postalCode].compactMap { $0 }.joined(separator: " ")
            if let street = [pm.subThoroughfare, pm.thoroughfare].compactMap({ $0 }).joined(separator: " ") as String?, !street.isEmpty { out.title = street }
        }
        return out
    }
}


/// "Use my location": one location fix, turned into an address (CoreLocation, when in use; the plist says why).
@MainActor
final class LocationAddress: NSObject, CLLocationManagerDelegate {
    private let manager = CLLocationManager()
    private var continuation: CheckedContinuation<AddressPlace?, Never>?

    override init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyNearestTenMeters
    }

    func find() async -> AddressPlace? {
        await withCheckedContinuation { (c: CheckedContinuation<AddressPlace?, Never>) in
            continuation = c
            switch manager.authorizationStatus {
            case .notDetermined: manager.requestWhenInUseAuthorization()
            case .denied, .restricted: finish(nil)
            default: manager.requestLocation()
            }
        }
    }

    private func finish(_ place: AddressPlace?) {
        continuation?.resume(returning: place)
        continuation = nil
    }

    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        let status = manager.authorizationStatus
        Task { @MainActor in
            guard self.continuation != nil else { return }
            if status == .authorizedWhenInUse || status == .authorizedAlways { manager.requestLocation() } else if status != .notDetermined { self.finish(nil) }
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let loc = locations.last else { return }
        Task { @MainActor in
            let marks = try? await CLGeocoder().reverseGeocodeLocation(loc)
            guard let pm = marks?.first, let street = [pm.subThoroughfare, pm.thoroughfare].compactMap({ $0 }).joined(separator: " ") as String?, !street.isEmpty,
                  let city = pm.locality, let state = pm.administrativeArea else { self.finish(nil); return }
            let region = [city + ",", state, pm.postalCode].compactMap { $0 }.joined(separator: " ")
            self.finish(AddressPlace(title: street, subtitle: "\(city), \(state)", coordinate: loc.coordinate, regionLine: region))
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        Task { @MainActor in self.finish(nil) }
    }
}
