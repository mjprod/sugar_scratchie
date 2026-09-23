import UIKit
import SwiftUI

/// Classic login layout (email / password / server / one primary button).
final class LoginViewController: UIViewController, UITextFieldDelegate {
    var vm: SmokeViewModel!

    private let scroll = UIScrollView()
    private let stack = UIStackView()
    private let titleLabel = UILabel()
    private let subtitleLabel = UILabel()
    private let serverButton = UIButton(type: .system)
    private let emailField = UITextField()
    private let passwordField = UITextField()
    private let errorLabel = UILabel()
    private let submitButton = UIButton(type: .system)
    private let modeButton = UIButton(type: .system)
    private let apiLabel = UILabel()
    private let spinner = UIActivityIndicatorView(style: .medium)

    private var refreshTimer: Timer?

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground

        titleLabel.text = "Sugar Scratchie"
        titleLabel.font = .preferredFont(forTextStyle: .largeTitle)
        titleLabel.textAlignment = .center

        subtitleLabel.text = "iOS smoke test"
        subtitleLabel.font = .preferredFont(forTextStyle: .subheadline)
        subtitleLabel.textColor = .secondaryLabel
        subtitleLabel.textAlignment = .center

        serverButton.contentHorizontalAlignment = .left
        serverButton.addTarget(self, action: #selector(pickServer), for: .touchUpInside)

        configure(emailField, placeholder: "Email", secure: false)
        emailField.keyboardType = .emailAddress
        emailField.autocapitalizationType = .none
        emailField.autocorrectionType = .no
        emailField.returnKeyType = .next

        configure(passwordField, placeholder: "Password", secure: true)
        passwordField.returnKeyType = .go

        errorLabel.textColor = .systemRed
        errorLabel.font = .preferredFont(forTextStyle: .footnote)
        errorLabel.numberOfLines = 0
        errorLabel.isHidden = true

        submitButton.setTitle("Log in", for: .normal)
        submitButton.titleLabel?.font = .boldSystemFont(ofSize: 17)
        submitButton.backgroundColor = .systemBlue
        submitButton.setTitleColor(.white, for: .normal)
        submitButton.layer.cornerRadius = 10
        submitButton.contentEdgeInsets = UIEdgeInsets(top: 14, left: 16, bottom: 14, right: 16)
        submitButton.addTarget(self, action: #selector(submit), for: .touchUpInside)

        modeButton.addTarget(self, action: #selector(toggleMode), for: .touchUpInside)

        apiLabel.font = .preferredFont(forTextStyle: .caption2)
        apiLabel.textColor = .secondaryLabel
        apiLabel.numberOfLines = 0
        apiLabel.textAlignment = .center

        spinner.hidesWhenStopped = true

        stack.axis = .vertical
        stack.spacing = 14
        stack.translatesAutoresizingMaskIntoConstraints = false
        [titleLabel, subtitleLabel, serverButton, emailField, passwordField, errorLabel, submitButton, spinner, modeButton, apiLabel]
            .forEach { stack.addArrangedSubview($0) }

        scroll.translatesAutoresizingMaskIntoConstraints = false
        scroll.keyboardDismissMode = .interactive
        scroll.alwaysBounceVertical = true
        scroll.delaysContentTouches = false
        view.addSubview(scroll)
        scroll.addSubview(stack)

        NSLayoutConstraint.activate([
            scroll.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            scroll.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            scroll.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            stack.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor, constant: 32),
            stack.leadingAnchor.constraint(equalTo: scroll.frameLayoutGuide.leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(equalTo: scroll.frameLayoutGuide.trailingAnchor, constant: -24),
            stack.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor, constant: -32),
            emailField.heightAnchor.constraint(equalToConstant: 44),
            passwordField.heightAnchor.constraint(equalToConstant: 44),
            submitButton.heightAnchor.constraint(greaterThanOrEqualToConstant: 48),
        ])

        let tap = UITapGestureRecognizer(target: self, action: #selector(endEditingTap))
        tap.cancelsTouchesInView = false
        view.addGestureRecognizer(tap)

        refreshFromViewModel()
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        refreshTimer?.invalidate()
        refreshTimer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
            self?.refreshFromViewModel()
        }
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        refreshTimer?.invalidate()
        refreshTimer = nil
    }

    private func configure(_ field: UITextField, placeholder: String, secure: Bool) {
        field.placeholder = placeholder
        field.borderStyle = .roundedRect
        field.isSecureTextEntry = secure
        field.delegate = self
        field.clearButtonMode = .whileEditing
        field.textContentType = .oneTimeCode
        field.autocorrectionType = .no
        field.spellCheckingType = .no
    }

    func refreshFromViewModel() {
        guard let vm else { return }
        if !emailField.isFirstResponder, emailField.text != vm.email {
            emailField.text = vm.email
        }
        if !passwordField.isFirstResponder, passwordField.text != vm.password {
            passwordField.text = vm.password
        }
        serverButton.setTitle("Server: \(vm.serverTarget.label) ▾", for: .normal)
        submitButton.setTitle(vm.registerMode ? "Register" : "Log in", for: .normal)
        modeButton.setTitle(
            vm.registerMode ? "Have an account? Log in" : "Need an account? Register",
            for: .normal
        )
        apiLabel.text = "API \(vm.apiBaseUrl)"
        if let error = vm.error, !error.isEmpty {
            errorLabel.text = error
            errorLabel.isHidden = false
        } else {
            errorLabel.isHidden = true
        }
        let canSubmit = !vm.email.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && vm.password.count >= 8
        submitButton.isEnabled = !vm.loading && canSubmit
        submitButton.alpha = submitButton.isEnabled ? 1 : 0.55
        serverButton.isEnabled = !vm.loading
        modeButton.isEnabled = !vm.loading
        if vm.loading { spinner.startAnimating() } else { spinner.stopAnimating() }
    }

    @objc private func endEditingTap() {
        view.endEditing(true)
    }

    @objc private func pickServer() {
        let sheet = UIAlertController(title: "Server", message: nil, preferredStyle: .actionSheet)
        for target in ServerTarget.allCases {
            sheet.addAction(UIAlertAction(title: target.label, style: .default) { [weak self] _ in
                self?.vm.onServerTargetChange(target)
                self?.refreshFromViewModel()
            })
        }
        sheet.addAction(UIAlertAction(title: "Cancel", style: .cancel))
        if let pop = sheet.popoverPresentationController {
            pop.sourceView = serverButton
            pop.sourceRect = serverButton.bounds
        }
        present(sheet, animated: true)
    }

    @objc private func toggleMode() {
        vm.toggleRegisterMode()
        refreshFromViewModel()
    }

    @objc private func submit() {
        syncFieldsToViewModel()
        view.endEditing(true)
        vm.submitAuth()
        refreshFromViewModel()
    }

    private func syncFieldsToViewModel() {
        vm.email = emailField.text ?? ""
        vm.password = passwordField.text ?? ""
        vm.error = nil
    }

    func textFieldDidChangeSelection(_ textField: UITextField) {
        syncFieldsToViewModel()
        refreshFromViewModel()
    }

    func textFieldShouldReturn(_ textField: UITextField) -> Bool {
        if textField === emailField {
            passwordField.becomeFirstResponder()
        } else {
            submit()
        }
        return true
    }
}

struct LoginView: UIViewControllerRepresentable {
    @Bindable var vm: SmokeViewModel

    func makeUIViewController(context: Context) -> LoginViewController {
        let vc = LoginViewController()
        vc.vm = vm
        return vc
    }

    func updateUIViewController(_ uiViewController: LoginViewController, context: Context) {
        uiViewController.vm = vm
        uiViewController.refreshFromViewModel()
    }
}
