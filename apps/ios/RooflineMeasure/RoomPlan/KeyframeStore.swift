import Foundation

/// The photos kept during a room scan, at most `capacity`. When it is full a new photo takes the place of the lowest-scoring
/// one (if it scores higher), so a long scan keeps its best photos instead of only its first sixty.
struct KeyframeStore<Payload> {
    struct Entry {
        var payload: Payload
        var score: Double
    }

    enum Outcome: Equatable {
        case added(index: Int)
        case replaced(index: Int)
        case dropped
    }

    let capacity: Int
    private(set) var entries: [Entry] = []

    init(capacity: Int) { self.capacity = capacity }

    var count: Int { entries.count }
    var isEmpty: Bool { entries.isEmpty }
    var payloads: [Payload] { entries.map { $0.payload } }
    subscript(i: Int) -> Payload { entries[i].payload }

    @discardableResult
    mutating func add(_ payload: Payload, score: Double) -> Outcome {
        if entries.count < capacity {
            entries.append(Entry(payload: payload, score: score))
            return .added(index: entries.count - 1)
        }
        guard let lowest = entries.indices.min(by: { entries[$0].score < entries[$1].score }), score > entries[lowest].score else { return .dropped }
        entries[lowest] = Entry(payload: payload, score: score)
        return .replaced(index: lowest)
    }

    /// How good a photo taken with the phone moving at these speeds is: a steady phone gives a sharp picture.
    static func score(metresPerSecond: Double, degreesPerSecond: Double) -> Double {
        1 / (1 + 2 * max(0, metresPerSecond) + max(0, degreesPerSecond) / 30)
    }
}
