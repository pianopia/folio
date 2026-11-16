require 'xcodeproj'

root = File.expand_path('../..', __dir__)
project_path = File.join(root, 'apps/mobile/ios/Folio.xcodeproj')
project = Xcodeproj::Project.open(project_path)
app = project.targets.find { |target| target.name == 'Folio' }
raise 'Folio application target was not generated' unless app

test = project.new_target(:ui_test_bundle, 'FolioScreenshots', :ios, '15.1')
test.add_dependency(app)
project.root_object.attributes['TargetAttributes'] ||= {}
project.root_object.attributes['TargetAttributes'][test.uuid] = { 'TestTargetID' => app.uuid }
test.build_configurations.each do |configuration|
  configuration.build_settings.merge!({
    'PRODUCT_NAME' => '$(TARGET_NAME)',
    'PRODUCT_BUNDLE_IDENTIFIER' => 'studio.folio.screenshots',
    'GENERATE_INFOPLIST_FILE' => 'YES',
    'SWIFT_VERSION' => '5.0',
    'TEST_TARGET_NAME' => 'Folio',
    'TARGETED_DEVICE_FAMILY' => '1,2',
    'CODE_SIGNING_ALLOWED' => 'NO'
  })
end
source = project.main_group.new_file(File.join(__dir__, 'FolioScreenshots.swift'))
test.source_build_phase.add_file_reference(source)
project.save

scheme = Xcodeproj::XCScheme.new
scheme.add_build_target(app)
scheme.add_build_target(test)
scheme.set_launch_target(app)
scheme.add_test_target(test)
scheme.test_action.build_configuration = 'Release'
scheme.save_as(project_path, 'FolioScreenshots', true)
