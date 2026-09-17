import SwiftUI
import CMMUsageCore

struct ModelsSectionView: View {
    @EnvironmentObject private var model: UsageAppModel
    let onAddProvider: () -> Void

    @State private var query = ""
    @State private var filter: ModelCatalogFilter = .all
    @State private var showPickerPreview = false
    @State private var actionError: String?

    private var filteredRoutes: [CatalogRouteEntry] {
        ModelCatalogPresenter.filteredRoutes(model.catalogRoutes, query: query, filter: filter)
    }

    private var groups: [ModelCatalogProviderGroup] {
        ModelCatalogPresenter.groups(filteredRoutes)
    }

    var body: some View {
        VStack(spacing: 0) {
            editorToolbar
            Divider()

            if model.catalogRoutes.isEmpty {
                EmptyStateView(
                    title: "No model routes yet",
                    detail: "Connect a provider to discover model routes, then choose which routes CMMChat should show.",
                    systemImage: "cpu"
                )
            } else if groups.isEmpty {
                EmptyStateView(
                    title: "No matching routes",
                    detail: "Change the search or access filter to see more model routes.",
                    systemImage: "magnifyingglass"
                )
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 8) {
                        if let actionError {
                            Label(actionError, systemImage: "exclamationmark.triangle")
                                .font(.caption)
                                .foregroundStyle(.orange)
                        }
                        ForEach(groups) { group in
                            ProviderModelGroupView(
                                group: group,
                                allQuotas: model.catalogQuotas,
                                onSetVisibility: setVisibility
                            )
                        }
                        Button(action: onAddProvider) {
                            Label("Add provider…", systemImage: "plus")
                        }
                        .buttonStyle(.borderless)
                        .padding(.top, 2)
                    }
                    .padding(.horizontal, 22)
                    .padding(.vertical, 12)
                    .frame(maxWidth: 820, alignment: .topLeading)
                    .frame(maxWidth: .infinity, alignment: .top)
                }
            }
        }
        .popover(isPresented: $showPickerPreview, arrowEdge: .top) {
            CompactModelPickerPreview(
                routes: model.catalogRoutes,
                onEditModels: { showPickerPreview = false }
            )
        }
    }

    private var editorToolbar: some View {
        HStack(spacing: 10) {
            HStack(spacing: 7) {
                Image(systemName: "magnifyingglass")
                    .foregroundStyle(.secondary)
                TextField("Search models, providers or products", text: $query)
                    .textFieldStyle(.plain)
                    .accessibilityLabel("Search model catalog")
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 7)
            .background(.quinary.opacity(0.35), in: RoundedRectangle(cornerRadius: 7, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 7, style: .continuous)
                    .stroke(.quaternary, lineWidth: 1)
            }
            .frame(maxWidth: 420)

            Picker("Access", selection: $filter) {
                ForEach(ModelCatalogFilter.allCases) { value in
                    Text(value.title).tag(value)
                }
            }
            .frame(width: 130)
            .controlSize(.small)

            Spacer()

            Button {
                showPickerPreview.toggle()
            } label: {
                Label("Picker Preview", systemImage: "rectangle.and.hand.point.up.left")
            }
            .buttonStyle(.borderless)
        }
        .padding(.horizontal, 22)
        .padding(.vertical, 11)
    }

    private func setVisibility(_ routes: [CatalogRouteEntry], _ state: CatalogVisibilityState) {
        let ids = routes.map(\.routeId)
        guard !ids.isEmpty else { return }
        Task {
            do {
                try await model.setRoutesVisibility(routeIds: ids, state: state)
                actionError = nil
            } catch {
                actionError = error.localizedDescription
            }
        }
    }
}

private struct ProviderModelGroupView: View {
    let group: ModelCatalogProviderGroup
    let allQuotas: [CatalogQuotaSummary]
    let onSetVisibility: ([CatalogRouteEntry], CatalogVisibilityState) -> Void

    private var routes: [CatalogRouteEntry] {
        group.products.flatMap(\.routes)
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 9) {
                Image(systemName: "bolt.horizontal.circle")
                    .foregroundStyle(.secondary)
                Text(group.provider.displayName)
                    .font(.subheadline.weight(.semibold))
                Text("\(routes.count)")
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(.secondary)
                Spacer()
                TriStateVisibilityButton(state: group.selectionState) {
                    onSetVisibility(routes, group.selectionState == .visible ? .hidden : .visible)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .background(.quinary.opacity(0.12))

            ForEach(Array(group.products.enumerated()), id: \.element.id) { productIndex, product in
                if productIndex > 0 { Divider() }
                ProductModelGroupView(product: product, allQuotas: allQuotas, onSetVisibility: onSetVisibility)
            }
        }
        .background(.quinary.opacity(0.045), in: RoundedRectangle(cornerRadius: 7, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 7, style: .continuous)
                .stroke(.quaternary.opacity(0.8), lineWidth: 1)
        }
        .clipShape(RoundedRectangle(cornerRadius: 7, style: .continuous))
    }
}

private struct ProductModelGroupView: View {
    let product: ModelCatalogProductGroup
    let allQuotas: [CatalogQuotaSummary]
    let onSetVisibility: ([CatalogRouteEntry], CatalogVisibilityState) -> Void

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Text(product.product.displayName)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                Spacer()
                TriStateVisibilityButton(state: product.selectionState) {
                    onSetVisibility(product.routes, product.selectionState == .visible ? .hidden : .visible)
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 5)

            Divider().padding(.leading, 14)

            ForEach(Array(product.routes.enumerated()), id: \.element.id) { index, route in
                ModelRouteRow(route: route, allQuotas: allQuotas, onSetVisibility: onSetVisibility)
                if index < product.routes.count - 1 { Divider().padding(.leading, 44) }
            }
        }
    }
}

private struct ModelRouteRow: View {
    let route: CatalogRouteEntry
    let allQuotas: [CatalogQuotaSummary]
    let onSetVisibility: ([CatalogRouteEntry], CatalogVisibilityState) -> Void
    @State private var expanded = false

    private var headlineQuota: CatalogQuotaSummary? {
        hierarchy.headlineQuota
    }

    private var hierarchy: ModelQuotaHierarchy {
        ModelCatalogPresenter.quotaHierarchy(for: route, allQuotas: allQuotas)
    }

    private var hasQuotaDetails: Bool {
        !hierarchy.modelLimits.isEmpty ||
        !hierarchy.sharedLimits.isEmpty ||
        !hierarchy.otherLimits.isEmpty ||
        !hierarchy.claimableAllowances.isEmpty
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 11) {
                Image(systemName: route.isVisibleInModelCatalog ? "circle.fill" : "circle")
                    .font(.system(size: 7))
                    .foregroundStyle(route.isVisibleInModelCatalog ? .primary : .tertiary)
                    .frame(width: 18)
                    .accessibilityHidden(true)

                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 7) {
                        Text(route.model.displayName)
                            .font(.subheadline.weight(.medium))
                        AccessOfferBadge(offer: route.offer)
                    }
                    HStack(spacing: 6) {
                        if let family = route.model.family {
                            Text(family)
                        }
                        if let quota = headlineQuota {
                            Text("·")
                            Text(quota.compactRemainingText)
                        }
                        if !hierarchy.sharedLimits.isEmpty {
                            Text("·")
                            Text("\(hierarchy.sharedLimits.count) shared limit\(hierarchy.sharedLimits.count == 1 ? "" : "s")")
                        }
                        if !hierarchy.claimableAllowances.isEmpty {
                            Text("·")
                            Label("Bonus available", systemImage: "gift")
                                .labelStyle(.titleAndIcon)
                        }
                        if route.usageStatus == .temporarilyUnavailable {
                            Text("·")
                            Text("Unavailable")
                        }
                    }
                    .font(.caption)
                    .foregroundStyle(.secondary)
                }

                Spacer(minLength: 18)

                if hasQuotaDetails {
                    Button {
                        withAnimation(.easeInOut(duration: 0.15)) { expanded.toggle() }
                    } label: {
                        Image(systemName: expanded ? "chevron.down" : "chevron.right")
                            .font(.caption.weight(.semibold))
                            .frame(width: 18, height: 18)
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(.secondary)
                    .accessibilityLabel(expanded ? "Hide quota details" : "Show quota details")
                }

                Toggle(
                    "Show \(route.model.displayName) through \(route.provider.displayName)",
                    isOn: Binding(
                        get: { route.isVisibleInModelCatalog },
                        set: { visible in
                            onSetVisibility([route], visible ? .visible : .hidden)
                        }
                    )
                )
                .labelsHidden()
                .toggleStyle(.switch)
                .controlSize(.small)
                .accessibilityValue(route.isVisibleInModelCatalog ? "Visible" : "Hidden")
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 6)

            if expanded && hasQuotaDetails {
                Divider().padding(.leading, 44)
                VStack(alignment: .leading, spacing: 9) {
                    if !hierarchy.modelLimits.isEmpty {
                        quotaSection("Model limits", quotas: hierarchy.modelLimits, kind: .model)
                    }
                    if !hierarchy.sharedLimits.isEmpty {
                        quotaSection("Shared pools", quotas: hierarchy.sharedLimits, kind: .shared)
                    }
                    if !hierarchy.otherLimits.isEmpty {
                        quotaSection("Other active limits", quotas: hierarchy.otherLimits, kind: .other)
                    }
                    if !hierarchy.claimableAllowances.isEmpty {
                        quotaSection("Bonus capacity", quotas: hierarchy.claimableAllowances, kind: .claimable)
                    }
                }
                .padding(.leading, 44)
                .padding(.trailing, 14)
                .padding(.vertical, 9)
                .background(.quinary.opacity(0.08))
            }
        }
    }

    @ViewBuilder
    private func quotaSection(_ title: String, quotas: [CatalogQuotaSummary], kind: ModelQuotaLine.Kind) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(title.uppercased())
                .font(.caption2.weight(.semibold))
                .foregroundStyle(.tertiary)
            ForEach(quotas) { quota in
                ModelQuotaLine(quota: quota, kind: kind)
            }
        }
    }
}

private struct ModelQuotaLine: View {
    enum Kind: Equatable {
        case model
        case shared
        case other
        case claimable
    }

    let quota: CatalogQuotaSummary
    let kind: Kind

    var body: some View {
        HStack(alignment: .top, spacing: 9) {
            Image(systemName: symbol)
                .font(.caption)
                .foregroundStyle(.secondary)
                .frame(width: 14, height: 16)

            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(quota.displayName)
                        .font(.caption.weight(.medium))
                    if kind == .shared, let count = quota.affectedRouteIds?.count, count > 1 {
                        Text("Shared with \(count) routes")
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                    }
                }
                if let progress = quota.progressFraction, kind != .claimable {
                    ProgressView(value: progress)
                        .progressViewStyle(.linear)
                        .frame(maxWidth: 220)
                        .accessibilityLabel("\(quota.displayName) used")
                        .accessibilityValue(progress.formatted(.percent.precision(.fractionLength(0))))
                }
            }

            Spacer(minLength: 14)

            VStack(alignment: .trailing, spacing: 2) {
                Text(kind == .claimable ? (quota.claimableValueText ?? "Bonus available") : quota.primaryValueText)
                    .font(.caption.weight(.semibold).monospacedDigit())
                Text(kind == .claimable ? claimText : quota.resetText)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private var symbol: String {
        switch kind {
        case .model: return "cpu"
        case .shared: return "arrow.triangle.branch"
        case .other: return "gauge.with.dots.needle.67percent"
        case .claimable: return "gift"
        }
    }

    private var claimText: String {
        quota.entitlement?.actionLabel ?? "Explicit claim required"
    }
}

private struct TriStateVisibilityButton: View {
    let state: CatalogSelectionState
    let action: () -> Void

    private var image: String {
        switch state {
        case .visible: return "checkmark.square.fill"
        case .hidden: return "square"
        case .mixed: return "minus.square.fill"
        }
    }

    private var value: String {
        switch state {
        case .visible: return "All visible"
        case .hidden: return "All hidden"
        case .mixed: return "Mixed"
        }
    }

    var body: some View {
        Button(action: action) {
            Image(systemName: image)
                .font(.system(size: 14, weight: .medium))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Model visibility")
        .accessibilityValue(value)
    }
}

struct CompactModelPickerPreview: View {
    let routes: [CatalogRouteEntry]
    let onEditModels: () -> Void
    @State private var query = ""

    private var visibleRoutes: [CatalogRouteEntry] {
        ModelCatalogPresenter.filteredRoutes(
            ModelCatalogPresenter.pickerRoutes(routes),
            query: query,
            filter: .all
        )
    }

    private var groups: [ModelCatalogProviderGroup] {
        ModelCatalogPresenter.groups(visibleRoutes)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(spacing: 7) {
                Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                TextField("Search models", text: $query)
                    .textFieldStyle(.plain)
            }
            .padding(.horizontal, 9)
            .padding(.vertical, 6)
            .background(.quinary.opacity(0.4), in: RoundedRectangle(cornerRadius: 7))

            ScrollView {
                LazyVStack(alignment: .leading, spacing: 7) {
                    ForEach(groups) { group in
                        VStack(alignment: .leading, spacing: 3) {
                            Text(group.provider.displayName)
                                .font(.caption2.weight(.semibold))
                                .foregroundStyle(.secondary)
                                .padding(.horizontal, 4)
                            ForEach(group.products.flatMap(\.routes)) { route in
                                HStack(spacing: 8) {
                                    VStack(alignment: .leading, spacing: 1) {
                                        Text(route.model.displayName)
                                            .font(.subheadline.weight(.medium))
                                        Text(route.product.displayName)
                                            .font(.caption2)
                                            .foregroundStyle(.secondary)
                                    }
                                    Spacer()
                                    AccessOfferBadge(offer: route.offer)
                                }
                                .padding(.horizontal, 7)
                                .padding(.vertical, 4)
                            }
                        }
                    }
                }
            }
            .frame(maxHeight: 320)

            Divider()
            Button(action: onEditModels) {
                Label("Edit models…", systemImage: "slider.horizontal.3")
            }
            .buttonStyle(.borderless)
        }
        .padding(9)
        .frame(width: 340)
    }
}
