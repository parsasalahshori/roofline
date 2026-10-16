import ARKit
import SwiftUI

/// Hosts the controller's ARSCNView.
struct ArSceneContainer: UIViewRepresentable {
    let view: ARSCNView
    func makeUIView(context: Context) -> ARSCNView { view }
    func updateUIView(_ uiView: ARSCNView, context: Context) {}
}
